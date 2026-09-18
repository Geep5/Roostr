package core

// Conversations: many chats per object.
//
// An object holds more than one conversation - the human's chat about it, and
// the agent-to-agent threads that ran alongside. All of them are blocks in
// THIS object's tree, so one object's protobuf carries every conversation it
// has had: no side channel, no second fetch, and no separate `chat` object
// per pair of agents (which is what produced 30 duplicate rows in the lists).
//
// Layout, reusing the block machinery rather than inventing a list:
//
//   root  block, custom content_type "discussion", custom.data = Conversation
//     └── child block, custom content_type "chat", meta{author, ts, text, …}
//
// Three properties come free from that choice: concurrent posts merge (block
// adds are commutative by id), replay is idempotent, and there is no cap -
// each message is one appended change rather than a rewrite of a growing
// field, so a thread costs the same at message 10 and message 10,000.
//
// The legacy root id "__discussion__" IS the human conversation. Vaults
// written before this file have no `data` on that root; it decodes as kind
// Human, which is what it always was.

import "core:slice"
import "core:strings"

Conversation_Kind :: enum i64 {
	Unspecified    = 0,
	Human          = 1,
	Agent_To_Agent = 2,
	Agent_Private  = 3,
}

Conversation :: struct {
	id:               string,
	kind:             Conversation_Kind,
	title:            string,
	participants:     [dynamic]string,
	created_at:       i64,
	opened_by:        string,
	about_message_id: string,
	closed:           bool,
	/** Fields a newer writer added, re-emitted verbatim. */
	unknown:          [dynamic]byte,
}

@(private = "file")
conversation_kind_from :: proc(v: i64) -> Conversation_Kind {
	switch v {
	case 1: return .Human
	case 2: return .Agent_To_Agent
	case 3: return .Agent_Private
	}
	return .Unspecified
}

decode_conversation :: proc(data: []byte, allocator := context.allocator) -> (Conversation, bool) {
	context.allocator = allocator
	out: Conversation
	out.participants = make([dynamic]string, allocator)
	out.unknown = make([dynamic]byte, allocator)
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		start := r.pos
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		switch field {
		case 1: out.id = read_string(&r)
		case 2: out.kind = conversation_kind_from(as_i64(read_varint(&r)))
		case 3: out.title = read_string(&r)
		case 4: append(&out.participants, read_string(&r))
		case 5: out.created_at = as_i64(read_varint(&r))
		case 6: out.opened_by = read_string(&r)
		case 7: out.about_message_id = read_string(&r)
		case 8: out.closed = read_varint(&r) != 0
		case:
			skip_field(&r, wire)
			if !r.err do append(&out.unknown, ..r.data[start:r.pos])
		}
	}
	return out, !r.err
}

encode_conversation :: proc(c: Conversation, allocator := context.allocator) -> []byte {
	w := Writer{buf = make([dynamic]byte, allocator)}
	write_string_field(&w, 1, c.id)
	if c.kind != .Unspecified {
		write_tag(&w, 2, 0)
		write_varint(&w, u64(c.kind))
	}
	write_string_field(&w, 3, c.title)
	for p in c.participants do write_string_field(&w, 4, p)
	write_i64_field(&w, 5, c.created_at)
	write_string_field(&w, 6, c.opened_by)
	write_string_field(&w, 7, c.about_message_id)
	write_bool_field(&w, 8, c.closed)
	if len(c.unknown) > 0 do append(&w.buf, ..c.unknown[:])
	return w.buf[:]
}

/** The root block id for a conversation minted by `mutation_id`. Prefixed so
 *  a thread root is recognisable without decoding, and so it can never
 *  collide with the legacy human root. */
conversation_root_id :: proc(mid: string, allocator := context.allocator) -> string {
	return strings.concatenate({"__thread__", mid}, allocator)
}

is_conversation_root :: proc(block_id: string) -> bool {
	if block_id == DISCUSSION_ID do return true
	return strings.has_prefix(block_id, "__thread__")
}

/** Every conversation in an object, oldest root first. The legacy human
 *  thread is reported even when its root carries no `data`, because an
 *  un-typed "__discussion__" has always been the human chat. */
object_conversations :: proc(st: ^Object_State, allocator := context.allocator) -> [dynamic]Conversation {
	out := make([dynamic]Conversation, allocator)
	if st == nil do return out
	for &b in st.blocks {
		if b.content.kind != .Custom do continue
		if b.content.custom.content_type != "discussion" do continue
		conversation: Conversation
		ok := true
		if len(b.content.custom.data) > 0 {
			conversation, ok = decode_conversation(b.content.custom.data, allocator)
		}
		if !ok do continue // a damaged root is skipped, never guessed at
		if conversation.id == "" do conversation.id = b.id
		if conversation.kind == .Unspecified && b.id == DISCUSSION_ID {
			conversation.kind = .Human
		}
		append(&out, conversation)
	}
	return out
}

/** Message count per conversation, without materialising the messages: the
 *  drawer's "12 threads" chip needs the number, not the text. */
conversation_message_count :: proc(st: ^Object_State, root_id: string) -> int {
	if st == nil do return 0
	for &b in st.blocks {
		if b.id != root_id do continue
		return len(b.children_ids)
	}
	return 0
}

conversations_equal :: proc(a, b: Conversation) -> bool {
	left := encode_conversation(a, context.temp_allocator)
	right := encode_conversation(b, context.temp_allocator)
	return slice.equal(left, right)
}

// ── Lookups used by the mutation planner ─────────────────────────────

@(private = "file")
Conversation_Lookup :: struct {
	object_id: string,
	thread_id: string,
	found:     bool,
	value:     Conversation,
}

/** Read a conversation's current metadata out of live state, so an update is
 *  a whole-message rewrite of what is actually there - including the unknown
 *  fields a newer client wrote, which must survive this build touching it. */
conversation_load :: proc(
	states: map[string]^Object_State,
	object_id, thread_id: string,
) -> (Conversation, bool) {
	lookup := Conversation_Lookup {
		object_id = object_id,
		thread_id = thread_id,
	}
	mutation_with_states(states, proc(states: map[string]^Object_State, user: rawptr) {
		l := (^Conversation_Lookup)(user)
		st, ok := states[l.object_id]
		if !ok do return
		for &b in st.blocks {
			if b.id != l.thread_id || b.content.kind != .Custom do continue
			if b.content.custom.content_type != "discussion" do continue
			decoded, valid := decode_conversation(b.content.custom.data, context.temp_allocator)
			if !valid do return // damaged root: refuse rather than overwrite
			if decoded.id == "" do decoded.id = b.id
			if decoded.kind == .Unspecified && b.id == DISCUSSION_ID do decoded.kind = .Human
			l.value = decoded
			l.found = true
			return
		}
	}, &lookup)
	return lookup.value, lookup.found
}

conversation_exists :: proc(states: map[string]^Object_State, object_id, thread_id: string) -> bool {
	_, found := conversation_load(states, object_id, thread_id)
	return found
}

/** Wire keys a caller sends, kept short and stable: "a2a" is what the harness
 *  already calls its pair chats. */
conversation_kind_from_key :: proc(key: string) -> Conversation_Kind {
	switch key {
	case "human": return .Human
	case "a2a", "agent_to_agent": return .Agent_To_Agent
	case "agent_private": return .Agent_Private
	}
	return .Unspecified
}

conversation_kind_key :: proc(kind: Conversation_Kind) -> string {
	switch kind {
	case .Human: return "human"
	case .Agent_To_Agent: return "a2a"
	case .Agent_Private: return "agent_private"
	case .Unspecified: return ""
	}
	return ""
}
