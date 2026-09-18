#+build !js
package core

// Many conversations in one object, driven through the real mutation loop:
// plan -> changes -> replay -> plan again against the computed state. That is
// the path the daemon, the browser core and the harness all take, so a thread
// that works here works on every host.

import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"
import "core:strings"
import "core:testing"

@(private = "file")
Vault :: struct {
	changes: [dynamic]Change,
	states:  map[string]^Object_State,
	clock:   i64,
	seq:     int,
}

/** Replay every change in the vault, grouped by object: a single mutation
 *  touches several objects (a `create` also seeds its type), and
 *  `compute_state` is per-object by design. */
@(private = "file")
replay :: proc(v: ^Vault) -> bool {
	v.states = make(map[string]^Object_State, context.temp_allocator)
	grouped := make(map[string][dynamic]Change, context.temp_allocator)
	for change in v.changes {
		list, seen := grouped[change.object_id]
		if !seen do list = make([dynamic]Change, context.temp_allocator)
		append(&list, change)
		grouped[change.object_id] = list
	}
	for object_id, list in grouped {
		state, ok := compute_state(list[:], context.temp_allocator)
		if !ok do return false
		ptr := new(Object_State, context.temp_allocator)
		ptr^ = state
		v.states[object_id] = ptr
	}
	return true
}

/** Run one mutation against the vault's current state and replay the result,
 *  exactly as a host does. Returns the mutation's `result` object. */
@(private = "file")
apply :: proc(v: ^Vault, action: string, request: json.Object, author := "device-a") -> (json.Value, string) {
	v.clock += 1
	v.seq += 1
	payload := jobj()
	payload["action"] = json.String(action)
	payload["params"] = request
	payload["timestamp"] = json.Integer(v.clock)
	payload["author"] = json.String(author)
	payload["id_seed"] = json.String(fmt.tprintf("seed-%d", v.seq))
	objects := make([dynamic]json.Value, context.temp_allocator)
	for _, state in v.states {
		parsed, err := json.parse(object_to_json(state, context.temp_allocator), parse_integers = true)
		if err != nil do return nil, "state did not round trip"
		append(&objects, parsed)
	}
	payload["objects"] = json.Array(objects)
	out, mutation_error := mutation_dispatch(json.Object(payload))
	if mutation_error != "" do return nil, mutation_error
	changes_value, _ := json_field(out, "changes")
	array, _ := changes_value.(json.Array)
	for item in array {
		change, ok := change_from_json(item, context.temp_allocator)
		if !ok do return nil, "invalid change"
		// Parent linkage is the HOST's job (`src/mutate.odin:19` reads the
		// object's current heads); the planner returns unparented changes.
		if state, seen := v.states[change.object_id]; seen {
			// `Object_State.heads` are hex; `Change.parent_ids` are raw
			// bytes. Appending the hex text would leave every change
			// parentless, and the head set would grow without bound.
			parents := make([dynamic][]byte, context.temp_allocator)
			for head in state.heads {
				id, decoded := hex.decode(transmute([]byte)head, context.temp_allocator)
				if !decoded do return nil, "invalid head"
				append(&parents, id)
			}
			change.parent_ids = parents
		}
		// The planner returns unhashed changes; content-addressing them is
		// the host's job (`codec_dispatch` "encode"), and the next plan's
		// parent_ids come from these ids.
		digest := sha256(encode_change(change, true, context.temp_allocator))
		// `digest` is a stack array: slicing it directly would leave every
		// change pointing at the same reused slot.
		id := make([]byte, len(digest), context.temp_allocator)
		copy(id, digest[:])
		change.id = id
		append(&v.changes, change)
	}
	if !replay(v) do return nil, "replay failed"
	result, _ := json_field(out, "result")
	return result, ""
}

@(private = "file")
state_of :: proc(v: ^Vault, object_id: string) -> ^Object_State {
	state, ok := v.states[object_id]
	if !ok do return nil
	return state
}

@(private = "file")
params :: proc(pairs: ..[2]string) -> json.Object {
	out := jobj()
	for p in pairs do out[p[0]] = json.String(p[1])
	return json.Object(out)
}

@(private = "file")
messages_in :: proc(st: ^Object_State, root_id: string) -> [dynamic]string {
	out := make([dynamic]string, context.temp_allocator)
	for &root in st.blocks {
		if root.id != root_id do continue
		for child_id in root.children_ids {
			for &b in st.blocks {
				if b.id != child_id || b.content.kind != .Custom do continue
				for p in b.content.custom.meta {
					if p.key == "text" do append(&out, p.value)
				}
			}
		}
	}
	return out
}

@(test)
object_holds_many_conversations :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v := Vault{changes = make([dynamic]Change, context.temp_allocator)}

	created, create_error := apply(&v, "create", params({"type_key", "note"}, {"name", "Pricing"}))
	testing.expect(t, create_error == "", create_error)
	object_id := json_str(created, "id")
	testing.expect(t, object_id != "", "object created")

	// The human thread: no thread_id, which is every existing caller.
	human, human_error := apply(&v, "chat_post", params({"object_id", object_id}, {"text", "what should we charge?"}))
	testing.expect(t, human_error == "", human_error)
	testing.expect_value(t, json_str(human, "threadId"), DISCUSSION_ID)

	// Two agents open their own thread about that very message, and talk in
	// it. The human thread must not see a word of it.
	opened, open_error := apply(
		&v,
		"conversation_open",
		params(
			{"object_id", object_id},
			{"kind", "a2a"},
			{"title", "Pricing research"},
			{"about_message_id", json_str(human, "id")},
		),
	)
	testing.expect(t, open_error == "", open_error)
	a2a := json_str(opened, "id")
	testing.expect(t, strings.has_prefix(a2a, "__thread__"), "thread root is marked as one")

	_, post_error := apply(
		&v,
		"chat_post",
		params({"object_id", object_id}, {"thread_id", a2a}, {"text", "pulled the competitor sheet"}, {"as_author", "agent-scout"}),
	)
	testing.expect(t, post_error == "", post_error)
	_, second_error := apply(
		&v,
		"chat_post",
		params({"object_id", object_id}, {"thread_id", a2a}, {"text", "median is $29"}, {"as_author", "agent-analyst"}),
	)
	testing.expect(t, second_error == "", second_error)

	// A third conversation: one agent's private reasoning, same object.
	private_opened, private_error := apply(&v, "conversation_open", params({"object_id", object_id}, {"kind", "agent_private"}))
	testing.expect(t, private_error == "", private_error)
	private := json_str(private_opened, "id")
	_, private_post_error := apply(
		&v,
		"chat_post",
		params({"object_id", object_id}, {"thread_id", private}, {"text", "check churn before answering"}, {"as_author", "agent-analyst"}),
	)
	testing.expect(t, private_post_error == "", private_post_error)

	conversations := object_conversations(state_of(&v, object_id), context.temp_allocator)
	testing.expect_value(t, len(conversations), 3)
	kinds := make(map[string]Conversation_Kind, context.temp_allocator)
	for c in conversations do kinds[c.id] = c.kind
	testing.expect_value(t, kinds[DISCUSSION_ID], Conversation_Kind.Human)
	testing.expect_value(t, kinds[a2a], Conversation_Kind.Agent_To_Agent)
	testing.expect_value(t, kinds[private], Conversation_Kind.Agent_Private)

	// Isolation: each thread holds exactly its own messages, in order.
	human_messages := messages_in(state_of(&v, object_id), DISCUSSION_ID)
	testing.expect_value(t, len(human_messages), 1)
	testing.expect_value(t, human_messages[0], "what should we charge?")
	a2a_messages := messages_in(state_of(&v, object_id), a2a)
	testing.expect_value(t, len(a2a_messages), 2)
	testing.expect_value(t, a2a_messages[0], "pulled the competitor sheet")
	testing.expect_value(t, a2a_messages[1], "median is $29")
	testing.expect_value(t, len(messages_in(state_of(&v, object_id), private)), 1)

	// The thread's metadata survives replay, including what it is about.
	for c in conversations {
		if c.id != a2a do continue
		testing.expect_value(t, c.title, "Pricing research")
		testing.expect_value(t, c.about_message_id, json_str(human, "id"))
		testing.expect_value(t, c.opened_by, "device-a")
		testing.expect(t, !c.closed, "a new thread is open")
	}
	testing.expect_value(t, conversation_message_count(state_of(&v, object_id), a2a), 2)
}

@(test)
conversation_update_is_last_writer_wins :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v := Vault{changes = make([dynamic]Change, context.temp_allocator)}
	created, _ := apply(&v, "create", params({"type_key", "note"}, {"name", "Launch"}))
	object_id := json_str(created, "id")
	opened, _ := apply(&v, "conversation_open", params({"object_id", object_id}, {"kind", "a2a"}, {"title", "draft"}))
	thread := json_str(opened, "id")

	participants := make([dynamic]json.Value, context.temp_allocator)
	append(&participants, json.String("agent-writer"), json.String("agent-editor"))
	update := params({"object_id", object_id}, {"thread_id", thread}, {"title", "Launch copy"})
	update["participants"] = json.Array(participants)
	update["closed"] = json.Boolean(true)
	_, update_error := apply(&v, "conversation_update", update)
	testing.expect(t, update_error == "", update_error)

	after, found := conversation_load(v.states, object_id, thread)
	testing.expect(t, found, "thread still there")
	testing.expect_value(t, after.title, "Launch copy")
	testing.expect(t, after.closed, "closed")
	testing.expect_value(t, len(after.participants), 2)
	testing.expect_value(t, after.participants[1], "agent-editor")
	// Kind is not something an update may silently drop.
	testing.expect_value(t, after.kind, Conversation_Kind.Agent_To_Agent)

	// A closed thread still accepts messages - closing is a view state, not
	// a lock, because an agent may answer after a human closes the tab.
	_, post_error := apply(&v, "chat_post", params({"object_id", object_id}, {"thread_id", thread}, {"text", "one more"}))
	testing.expect(t, post_error == "", post_error)
	testing.expect_value(t, conversation_message_count(state_of(&v, object_id), thread), 1)
}

@(test)
posting_to_an_unopened_thread_is_refused :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v := Vault{changes = make([dynamic]Change, context.temp_allocator)}
	created, _ := apply(&v, "create", params({"type_key", "note"}, {"name", "Notes"}))
	object_id := json_str(created, "id")
	// A ghost thread would be a message present in the object and absent from
	// every conversation - the exact orphaning `block_add` was fixed for.
	_, err := apply(&v, "chat_post", params({"object_id", object_id}, {"thread_id", "__thread__typo"}, {"text", "hello"}))
	testing.expect_value(t, err, "conversation not found")
	_, update_error := apply(&v, "conversation_update", params({"object_id", object_id}, {"thread_id", "__thread__typo"}, {"title", "x"}))
	testing.expect_value(t, update_error, "conversation not found")
}

@(test)
legacy_discussion_is_the_human_conversation :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// A vault written before Conversation existed: the root carries no data.
	// It must read as the human thread, not as an unspecified stranger.
	v := Vault{changes = make([dynamic]Change, context.temp_allocator)}
	created, _ := apply(&v, "create", params({"type_key", "note"}, {"name", "Old note"}))
	object_id := json_str(created, "id")
	_, err := apply(&v, "chat_post", params({"object_id", object_id}, {"text", "from last year"}))
	testing.expect(t, err == "", err)
	for &b in state_of(&v, object_id).blocks {
		if b.id != DISCUSSION_ID do continue
		testing.expect_value(t, len(b.content.custom.data), 0)
	}
	conversations := object_conversations(state_of(&v, object_id), context.temp_allocator)
	testing.expect_value(t, len(conversations), 1)
	testing.expect_value(t, conversations[0].kind, Conversation_Kind.Human)
	testing.expect_value(t, conversations[0].id, DISCUSSION_ID)
}

@(test)
conversation_keeps_fields_it_cannot_name :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// A thread opened by a newer client, then edited by this build: the
	// rewrite must not strip what it cannot read.
	w := Writer{buf = make([dynamic]byte)}
	write_string_field(&w, 1, "__thread__future")
	write_tag(&w, 2, 0)
	write_varint(&w, u64(Conversation_Kind.Agent_To_Agent))
	write_string_field(&w, 3, "From next year")
	write_string_field(&w, 12, "a field this build has never heard of")
	from_future := w.buf[:]

	decoded, ok := decode_conversation(from_future)
	testing.expect(t, ok, "decodes")
	testing.expect_value(t, decoded.kind, Conversation_Kind.Agent_To_Agent)
	testing.expect(t, len(decoded.unknown) > 0, "unknown bytes captured")

	edited := decoded
	edited.title = "Renamed here"
	round_tripped, _ := decode_conversation(encode_conversation(edited))
	testing.expect_value(t, round_tripped.title, "Renamed here")
	testing.expect(t, len(round_tripped.unknown) > 0, "the future field survived this build's edit")
}

@(test)
a_thread_has_no_practical_cap :: proc(t: ^testing.T) {
	// "No cap on the happy path" is a storage claim: a message is ONE
	// appended block, never a rewrite of a growing field. Post a few hundred
	// across two threads and check both the ordering and that per-message
	// change size stays flat - if a message ever rewrote the thread, the last
	// change would dwarf the first.
	v := Vault{changes = make([dynamic]Change, context.temp_allocator)}
	created, _ := apply(&v, "create", params({"type_key", "note"}, {"name", "Long thread"}))
	object_id := json_str(created, "id")
	opened, _ := apply(&v, "conversation_open", params({"object_id", object_id}, {"kind", "a2a"}))
	thread := json_str(opened, "id")

	first_size, last_size := 0, 0
	for i in 0 ..< 60 {
		before := len(v.changes)
		_, err := apply(
			&v,
			"chat_post",
			params({"object_id", object_id}, {"thread_id", thread}, {"text", fmt.tprintf("m%d", i)}),
		)
		testing.expect(t, err == "", err)
		size := len(encode_change(v.changes[before], false, context.temp_allocator))
		if i == 0 do first_size = size
		last_size = size
		// Also interleave the human thread, so both stay independent.
		_, human_err := apply(&v, "chat_post", params({"object_id", object_id}, {"text", fmt.tprintf("h%d", i)}))
		testing.expect(t, human_err == "", human_err)
	}
	testing.expect_value(t, conversation_message_count(state_of(&v, object_id), thread), 60)
	testing.expect_value(t, conversation_message_count(state_of(&v, object_id), DISCUSSION_ID), 60)
	testing.expect(
		t,
		last_size < first_size + 8,
		fmt.tprintf("the last message costs %d bytes vs %d for the first - a thread must not rewrite itself", last_size, first_size),
	)
	thread_messages := messages_in(state_of(&v, object_id), thread)
	testing.expect_value(t, thread_messages[0], "m0")
	testing.expect_value(t, thread_messages[59], "m59")
	testing.expect_value(t, len(object_conversations(state_of(&v, object_id), context.temp_allocator)), 2)
}
