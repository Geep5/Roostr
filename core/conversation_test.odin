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
		parsed, err := json.parse(object_to_json(state, context.temp_allocator), allocator = context.temp_allocator, parse_integers = true)
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

	// Old A2A roots remain readable, but new shared-thread writes must be
	// refused; every agent exchange now uses per-object message envelopes.
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
	testing.expect(t, post_error != "", "legacy A2A posts are refused")
	_, second_error := apply(
		&v,
		"chat_post",
		params({"object_id", object_id}, {"thread_id", a2a}, {"text", "median is $29"}, {"as_author", "agent-analyst"}),
	)
	testing.expect(t, second_error != "", "legacy A2A posts stay read-only")

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
	testing.expect_value(t, len(a2a_messages), 0)
	testing.expect_value(t, len(messages_in(state_of(&v, object_id), private)), 1)

	// The thread's metadata survives replay, including what it is about.
	for c in conversations {
		if c.id != a2a do continue
		testing.expect_value(t, c.title, "Pricing research")
		testing.expect_value(t, c.about_message_id, json_str(human, "id"))
		testing.expect_value(t, c.opened_by, "device-a")
		testing.expect(t, !c.closed, "a new thread is open")
	}
	testing.expect_value(t, conversation_message_count(state_of(&v, object_id), a2a), 0)
}

@(test)
conversation_update_is_last_writer_wins :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v := Vault{changes = make([dynamic]Change, context.temp_allocator)}
	created, _ := apply(&v, "create", params({"type_key", "note"}, {"name", "Launch"}))
	object_id := json_str(created, "id")
	opened, _ := apply(&v, "conversation_open", params({"object_id", object_id}, {"kind", "agent_private"}, {"title", "draft"}))
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
	testing.expect_value(t, after.kind, Conversation_Kind.Agent_Private)

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
	testing.expect(t, err != "", "unknown thread must reject writes")
	_, update_error := apply(&v, "conversation_update", params({"object_id", object_id}, {"thread_id", "__thread__typo"}, {"title", "x"}))
	testing.expect(t, update_error != "", "unknown thread must reject updates")
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

	edited := decoded
	edited.title = "Renamed here"
	round_tripped, _ := decode_conversation(encode_conversation(edited))
	testing.expect_value(t, round_tripped.title, "Renamed here")
	expected := Writer{buf = make([dynamic]byte)}
	write_string_field(&expected, 12, "a field this build has never heard of")
	testing.expect_value(t, string(round_tripped.unknown[:]), string(expected.buf[:]))
}

@(test)
a_thread_has_no_practical_cap :: proc(t: ^testing.T) {
	// Long private transcripts and the human discussion retain every
	// message independently after repeated state JSON/replay round-trips.
	v := Vault{changes = make([dynamic]Change, context.temp_allocator)}
	created, _ := apply(&v, "create", params({"type_key", "note"}, {"name", "Long thread"}))
	object_id := json_str(created, "id")
	opened, _ := apply(&v, "conversation_open", params({"object_id", object_id}, {"kind", "agent_private"}))
	thread := json_str(opened, "id")

	for i in 0 ..< 60 {
		_, err := apply(
			&v,
			"chat_post",
			params({"object_id", object_id}, {"thread_id", thread}, {"text", fmt.tprintf("m%d", i)}),
		)
		testing.expect(t, err == "", err)
		// Also interleave the human thread, so both stay independent.
		_, human_err := apply(&v, "chat_post", params({"object_id", object_id}, {"text", fmt.tprintf("h%d", i)}))
		testing.expect(t, human_err == "", human_err)
	}
	testing.expect_value(t, conversation_message_count(state_of(&v, object_id), thread), 60)
	testing.expect_value(t, conversation_message_count(state_of(&v, object_id), DISCUSSION_ID), 60)
	thread_messages := messages_in(state_of(&v, object_id), thread)
	testing.expect_value(t, thread_messages[0], "m0")
	testing.expect_value(t, thread_messages[59], "m59")
	testing.expect_value(t, len(object_conversations(state_of(&v, object_id), context.temp_allocator)), 2)
}

@(test)
object_json_names_its_conversations :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// Every host reads object state through `object_to_json`, so the decoded
	// conversation list must be there - otherwise each client grows its own
	// protobuf reader, which is the duplication this schema removes.
	v := Vault{changes = make([dynamic]Change, context.temp_allocator)}
	created, _ := apply(&v, "create", params({"type_key", "note"}, {"name", "Pricing"}))
	object_id := json_str(created, "id")
	_, _ = apply(&v, "chat_post", params({"object_id", object_id}, {"text", "human question"}))
	opened, _ := apply(&v, "conversation_open", params({"object_id", object_id}, {"kind", "a2a"}, {"title", "Research"}))
	thread := json_str(opened, "id")
	for id in ([]string{"agent-one", "agent-two"}) {
		message := Agent_Message{id = id, exchange_id = strings.trim_prefix(thread, "__thread__"), sender = {object_id = object_id}, sent_at = v.clock, text = id, recipients = make([dynamic]Agent_Endpoint)}
		append(&message.recipients, Agent_Endpoint{object_id = object_id})
		send := params({"object_id", object_id})
		send["message"] = agent_message_to_json(message)
		_, send_error := apply(&v, "message_send", send)
		testing.expect(t, send_error == "", send_error)
	}

	parsed, err := json.parse(object_to_json(state_of(&v, object_id), context.temp_allocator), parse_integers = true)
	testing.expect(t, err == nil, "state JSON parses")
	rows := json_array(parsed, "conversations")
	testing.expect_value(t, len(rows), 2)
	seen := make(map[string]json.Value, context.temp_allocator)
	for row in rows do seen[json_str(row, "id")] = row
	human, human_ok := seen[DISCUSSION_ID]
	testing.expect(t, human_ok, "the human thread is listed")
	testing.expect_value(t, json_str(human, "kind"), "human")
	count, _ := json_int(human, "messageCount")
	testing.expect_value(t, count, 1)
	agent, agent_ok := seen[thread]
	testing.expect(t, agent_ok, "the agent thread is listed")
	testing.expect_value(t, json_str(agent, "kind"), "a2a")
	testing.expect_value(t, json_str(agent, "title"), "Research")
	agent_count, _ := json_int(agent, "messageCount")
	testing.expect_value(t, agent_count, 2)

	// An object with no chat carries no `conversations` key at all: a note
	// must not pay bytes for a conversation it never had.
	quiet := Vault{changes = make([dynamic]Change, context.temp_allocator)}
	made, _ := apply(&quiet, "create", params({"type_key", "note"}, {"name", "Quiet"}))
	quiet_id := json_str(made, "id")
	quiet_parsed, _ := json.parse(object_to_json(state_of(&quiet, quiet_id), context.temp_allocator), parse_integers = true)
	_, has_key := json_field(quiet_parsed, "conversations")
	testing.expect(t, !has_key, "no conversations key without a conversation")
}

@(private = "file")
mail_object :: proc(t: ^testing.T, v: ^Vault, kind := "note", space := "", binding := "", space_default := "") -> string {
	request := params({"type_key", kind})
	fields := jobj()
	fields["channel"] = value_to_json(string_value(space))
	if binding != "" do fields["bound_object"] = value_to_json(string_value(binding))
	if space_default != "" do fields["space_default"] = value_to_json(string_value(space_default))
	request["fields"] = json.Object(fields)
	result, err := apply(v, "create", request)
	testing.expect(t, err == "", err)
	return json_str(result, "id")
}

@(private = "file")
mail_envelope :: proc(id, source: string, recipients: ..Agent_Endpoint) -> Agent_Message {
	message := Agent_Message{id = id, exchange_id = "group", sender = {object_id = source}, text = "A durable request", sent_at = 100, title = "Shared work", recipients = make([dynamic]Agent_Endpoint, context.temp_allocator)}
	append(&message.recipients, ..recipients)
	return message
}

@(private = "file")
mail_send :: proc(v: ^Vault, message: Agent_Message) -> (json.Value, string) {
	request := params({"object_id", message.sender.object_id})
	request["message"] = agent_message_to_json(message)
	return apply(v, "message_send", request)
}

@(private = "file")
mail_deliver :: proc(v: ^Vault, message: Agent_Message, recipient: string) -> (json.Value, string) {
	return apply(v, "message_deliver", params({"sender_object_id", message.sender.object_id}, {"message_id", message.id}, {"recipient_object_id", recipient}))
}

@(private = "file")
mail_process :: proc(v: ^Vault, object_id, id, status, owner: string) -> (json.Value, string) {
	return apply(v, "message_processing", params({"object_id", object_id}, {"message_id", id}, {"status", status}, {"owner", owner}))
}

@(test)
mailbox_group_fanout_is_canonical_and_idempotent :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v := Vault{changes = make([dynamic]Change)}
	source := mail_object(t, &v)
	left := mail_object(t, &v)
	right := mail_object(t, &v)
	message := mail_envelope("group-message", source, Agent_Endpoint{object_id = left}, Agent_Endpoint{object_id = right})
	_, send_error := mail_send(&v, message)
	testing.expect(t, send_error == "", send_error)
	before := len(v.changes)
	_, duplicate_error := mail_send(&v, message)
	testing.expect(t, duplicate_error == "", duplicate_error)
	testing.expect_value(t, len(v.changes), before)
	testing.expect_value(t, len(object_mailbox(state_of(&v, left))), 0)

	// A caller cannot replace the sender's bytes while delivering them.
	request := params({"sender_object_id", source}, {"message_id", message.id}, {"recipient_object_id", left})
	forged := message
	forged.text = "not the canonical message"
	request["message"] = agent_message_to_json(forged)
	_, deliver_error := apply(&v, "message_deliver", request)
	testing.expect(t, deliver_error == "", deliver_error)
	testing.expect_value(t, v.changes[before].object_id, left)
	testing.expect_value(t, v.changes[before + 1].object_id, source)
	received, receiver_block, receiver_error := message_load(state_of(&v, left), message.id)
	testing.expect(t, receiver_error == "", receiver_error)
	testing.expect_value(t, received.text, message.text)
	sent, sender_block, _ := message_load(state_of(&v, source), message.id)
	testing.expect_value(t, string(receiver_block.content.custom.data), string(sender_block.content.custom.data))
	testing.expect_value(t, message_status(state_of(&v, source), sent, left).status, "delivered")
	testing.expect_value(t, message_status(state_of(&v, source), sent, right).status, "pending")
	before = len(v.changes)
	_, duplicate_delivery_error := mail_deliver(&v, message, left)
	testing.expect(t, duplicate_delivery_error == "", duplicate_delivery_error)
	testing.expect_value(t, len(v.changes), before)
	_, stale_error := apply(&v, "message_delivery_error", params({"object_id", source}, {"message_id", message.id}, {"recipient_object_id", left}, {"error", "late timeout"}))
	testing.expect(t, stale_error == "", stale_error)
	testing.expect_value(t, len(v.changes), before)
	_, fail_error := apply(&v, "message_delivery_error", params({"object_id", source}, {"message_id", message.id}, {"recipient_object_id", right}, {"error", "offline"}))
	testing.expect(t, fail_error == "", fail_error)
	before = len(v.changes)
	_, _ = apply(&v, "message_delivery_error", params({"object_id", source}, {"message_id", message.id}, {"recipient_object_id", right}, {"error", "offline"}))
	testing.expect_value(t, len(v.changes), before)
	testing.expect_value(t, message_status(state_of(&v, source), sent, right).status, "failed")
	_, right_error := mail_deliver(&v, message, right)
	testing.expect(t, right_error == "", right_error)
	testing.expect_value(t, len(object_mailbox(state_of(&v, right))), 1)
	testing.expect_value(t, conversation_message_count(state_of(&v, source), "__thread__group"), 1)
	row := object_mailbox(state_of(&v, source))[0]
	testing.expect_value(t, len(json_array(row, "deliveries")), 2)
	processing, _ := json_field(row, "processing")
	testing.expect_value(t, json_str(processing, "status"), "pending")
}

@(test)
mailbox_rejects_source_receiver_and_status_collisions :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v := Vault{changes = make([dynamic]Change)}
	source := mail_object(t, &v)
	target := mail_object(t, &v)
	message := mail_envelope("collision", source, Agent_Endpoint{object_id = target})
	_, send_error := mail_send(&v, message)
	testing.expect(t, send_error == "", send_error)
	before := len(v.changes)
	changed := message
	changed.text = "overwrite"
	_, collision_error := mail_send(&v, changed)
	testing.expect(t, collision_error != "", "same id cannot overwrite source")
	testing.expect_value(t, len(v.changes), before)
	block_request := params({"object_id", target})
	block_request["block"] = block_to_json(Block{id = message.id, content = {kind = .Text, text = {text = "unrelated content"}}})
	_, block_error := apply(&v, "block_add", block_request)
	testing.expect(t, block_error == "", block_error)
	_, receiver_error := mail_deliver(&v, message, target)
	testing.expect(t, receiver_error != "", "receiver collision must prevent delivery")
	sent, _, _ := message_load(state_of(&v, source), message.id)
	testing.expect_value(t, message_status(state_of(&v, source), sent, target).status, "pending")
	_, remove_error := apply(&v, "block_remove", params({"object_id", target}, {"block_id", message.id}))
	testing.expect(t, remove_error == "", remove_error)
	block_request = params({"object_id", source})
	block_request["block"] = block_to_json(Block{id = message_status_id(message.id, target), content = {kind = .Text, text = {text = "not a receipt"}}})
	_, _ = apply(&v, "block_add", block_request)
	_, status_error := mail_deliver(&v, message, target)
	testing.expect(t, status_error != "", "status collision must not overwrite content")
	testing.expect_value(t, len(object_mailbox(state_of(&v, target))), 0)
}

@(test)
mailbox_processing_claims_are_owned_and_terminal :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v := Vault{changes = make([dynamic]Change)}
	source := mail_object(t, &v)
	target := mail_object(t, &v)
	message := mail_envelope("claimed", source, Agent_Endpoint{object_id = target})
	_, send_error := mail_send(&v, message)
	testing.expect(t, send_error == "", send_error)
	_, delivery_error := mail_deliver(&v, message, target)
	testing.expect(t, delivery_error == "", delivery_error)
	_, source_error := mail_process(&v, source, message.id, "processing", "wrong-side")
	testing.expect(t, source_error != "", "outgoing-only message is not claimable")
	_, approval_error := mail_process(&v, target, message.id, "awaiting_approval", "")
	testing.expect(t, approval_error != "", "ordinary exchanges do not await capability approval")
	first, claim_error := mail_process(&v, target, message.id, "processing", "worker-one")
	testing.expect(t, claim_error == "", claim_error)
	claimed, _ := json_bool(first, "claimed")
	testing.expect(t, claimed, "first worker claims pending inbox")
	before := len(v.changes)
	second, second_error := mail_process(&v, target, message.id, "processing", "worker-two")
	testing.expect(t, second_error == "", second_error)
	second_claimed, _ := json_bool(second, "claimed")
	testing.expect(t, !second_claimed, "second worker may not run same message")
	testing.expect_value(t, len(v.changes), before)
	_, owner_error := mail_process(&v, target, message.id, "processed", "worker-two")
	testing.expect(t, owner_error != "", "wrong owner cannot complete processing")
	_, failure_error := mail_process(&v, target, message.id, "failed", "worker-one")
	testing.expect(t, failure_error == "", failure_error)
	failed_claim, _ := mail_process(&v, target, message.id, "processing", "worker-two")
	failed_claimed, _ := json_bool(failed_claim, "claimed")
	testing.expect(t, !failed_claimed, "failed side effects never silently rerun")
	_, retry_error := apply(&v, "message_retry", params({"object_id", target}, {"message_id", message.id}, {"stage", "processing"}))
	testing.expect(t, retry_error == "", retry_error)
	retried, retry_claim_error := mail_process(&v, target, message.id, "processing", "worker-two")
	testing.expect(t, retry_claim_error == "", retry_claim_error)
	retry_claimed, _ := json_bool(retried, "claimed")
	testing.expect(t, retry_claimed, "explicit retry makes failed work claimable")
	_, old_owner_error := mail_process(&v, target, message.id, "failed", "worker-one")
	testing.expect(t, old_owner_error != "", "previous owner loses completion rights after retry")
	_, finish_error := mail_process(&v, target, message.id, "processed", "worker-two")
	testing.expect(t, finish_error == "", finish_error)
	before = len(v.changes)
	_, _ = mail_process(&v, target, message.id, "processed", "worker-two")
	_, _ = apply(&v, "message_retry", params({"object_id", target}, {"message_id", message.id}, {"stage", "processing"}))
	terminal, _, _ := message_load(state_of(&v, target), message.id)
	testing.expect_value(t, message_status(state_of(&v, target), terminal, "").status, "processed")
	testing.expect_value(t, len(v.changes), before)
}

@(test)
mailbox_unknown_envelope_fields_survive_old_reader_delivery :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v := Vault{changes = make([dynamic]Change)}
	source := mail_object(t, &v)
	target := mail_object(t, &v)
	message := mail_envelope("future", source, Agent_Endpoint{object_id = target})
	extra := Writer{buf = make([dynamic]byte)}
	write_string_field(&extra, 31, "future message property")
	message.unknown = extra.buf
	endpoint_extra := Writer{buf = make([dynamic]byte)}
	write_i64_field(&endpoint_extra, 9, 42)
	message.sender.unknown = endpoint_extra.buf
	_, err := mail_send(&v, message)
	testing.expect(t, err == "", err)
	_, delivery_error := mail_deliver(&v, message, target)
	testing.expect(t, delivery_error == "", delivery_error)
	rows := json_array(object_to_json_value(state_of(&v, target)), "mailbox")
	projected, _ := json_field(rows[0], "message")
	recovered, ok := agent_message_from_json(projected)
	testing.expect(t, ok, "projected envelope can be encoded by old reader")
	testing.expect_value(t, string(recovered.unknown[:]), string(extra.buf[:]))
	testing.expect_value(t, string(recovered.sender.unknown[:]), string(endpoint_extra.buf[:]))
	sent, source_block, _ := message_load(state_of(&v, source), message.id)
	received, target_block, _ := message_load(state_of(&v, target), message.id)
	testing.expect_value(t, string(source_block.content.custom.data), string(target_block.content.custom.data))
	testing.expect_value(t, string(encode_agent_message(sent)), string(encode_agent_message(received)))
	// Unknown JSON fields cannot smuggle operation arguments, and encoded
	// \"unknown\" fields cannot override a known author or recipient.
	bad := agent_message_to_json(message).(json.Object)
	bad["fields"] = json.Object(jobj())
	_, bad_ok := agent_message_from_json(bad)
	testing.expect(t, !bad_ok, "arbitrary envelope arguments are rejected")
	known := Writer{buf = make([dynamic]byte)}
	write_string_field(&known, 12, "forged author")
	message.unknown = known.buf
	_, override_ok := agent_message_from_json(agent_message_to_json(message))
	testing.expect(t, !override_ok, "unknown bytes cannot override known fields")
}

@(test)
mailbox_human_self_groups_and_agent_binding_boundaries :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v := Vault{changes = make([dynamic]Change)}
	space := mail_object(t, &v, "channel")
	other_space := mail_object(t, &v, "channel")
	source := mail_object(t, &v, "note", space)
	agent := mail_object(t, &v, "agent", space, source)
	target := mail_object(t, &v, "note", space)
	foreign_object := mail_object(t, &v, "note", other_space)
	message := mail_envelope("human-self", source, Agent_Endpoint{object_id = source, agent_id = agent}, Agent_Endpoint{object_id = target})
	_, err := mail_send(&v, message)
	testing.expect(t, err == "", err)
	row := object_mailbox(state_of(&v, source))[0]
	incoming, _ := json_bool(row, "incoming")
	outgoing, _ := json_bool(row, "outgoing")
	testing.expect(t, incoming && outgoing, "human may address own agent in a group")
	_, self_error := mail_deliver(&v, message, source)
	testing.expect(t, self_error == "", self_error)
	followup := message
	followup.id = "human-followup"
	followup.reply_to = message.id
	followup.request_reply = true
	_, followup_error := mail_send(&v, followup)
	testing.expect(t, followup_error == "", "explicit human followup may ask for another response")
	message.id = "agent-self"
	message.sender.agent_id = agent
	_, agent_self_error := mail_send(&v, message)
	testing.expect(t, agent_self_error != "", "agent cannot target itself")
	message.recipients = make([dynamic]Agent_Endpoint)
	append(&message.recipients, Agent_Endpoint{object_id = target})
	message.sender.object_id = target
	_, binding_error := mail_send(&v, message)
	testing.expect(t, binding_error != "", "bound agent cannot claim another sender object")
	message.sender.object_id = source
	message.recipients[0].object_id = foreign_object
	_, space_error := mail_send(&v, message)
	testing.expect(t, space_error != "", "ordinary message cannot cross spaces")
	message.sender.agent_id = ""
	message.recipients[0].object_id = target
	append(&message.recipients, Agent_Endpoint{object_id = target})
	_, duplicate_error := mail_send(&v, message)
	testing.expect(t, duplicate_error != "", "recipient snapshot is distinct by object")
	default_agent := mail_object(t, &v, "agent", space, "", space)
	space_message := mail_envelope("space-default", space, Agent_Endpoint{object_id = target})
	space_message.sender.agent_id = default_agent
	_, default_error := mail_send(&v, space_message)
	testing.expect(t, default_error == "", default_error)
}

@(test)
mailbox_capability_approval_and_global_service_replies :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v := Vault{changes = make([dynamic]Change)}
	space := mail_object(t, &v, "channel")
	source := mail_object(t, &v, "note", space)
	install := mail_object(t, &v, "install")
	request := mail_envelope("auth-request", source, Agent_Endpoint{object_id = install})
	request.operation = "auth.check"
	_, send_error := mail_send(&v, request)
	testing.expect(t, send_error == "", send_error)
	_, delivery_error := mail_deliver(&v, request, install)
	testing.expect(t, delivery_error == "", delivery_error)
	_, approval_error := mail_process(&v, install, request.id, "awaiting_approval", "")
	testing.expect(t, approval_error == "", approval_error)
	loaded, _, _ := message_load(state_of(&v, install), request.id)
	testing.expect_value(t, message_status(state_of(&v, install), loaded, "").status, "awaiting_approval")
	claim, claim_error := mail_process(&v, install, request.id, "processing", "paired-approval")
	testing.expect(t, claim_error == "", claim_error)
	claimed, _ := json_bool(claim, "claimed")
	testing.expect(t, claimed, "approval can claim waiting request")
	reply := mail_envelope("auth-result", install, Agent_Endpoint{object_id = source})
	_, ungrounded_error := mail_send(&v, reply)
	testing.expect(t, ungrounded_error != "", "global install is not a general cross-space sender")
	reply.reply_to = request.id
	_, reply_error := mail_send(&v, reply)
	testing.expect(t, reply_error == "", reply_error)
	_, reply_delivery_error := mail_deliver(&v, reply, source)
	testing.expect(t, reply_delivery_error == "", reply_delivery_error)
	third_party := mail_object(t, &v, "note", space)
	reply.id = "auth-leak"
	reply.recipients[0].object_id = third_party
	_, third_party_error := mail_send(&v, reply)
	testing.expect(t, third_party_error != "", "service reply cannot add unrelated recipients")
}

@(test)
historical_mail_converts_only_matching_legacy_messages :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v := Vault{changes = make([dynamic]Change)}
	source := mail_object(t, &v)
	target := mail_object(t, &v)
	opened, _ := apply(&v, "conversation_open", params({"object_id", source}, {"kind", "a2a"}))
	root_id := json_str(opened, "id")
	message := mail_envelope("legacy-original", source, Agent_Endpoint{object_id = target})
	message.exchange_id = strings.trim_prefix(root_id, "__thread__")
	message.historical = true
	message.author = "device-a"
	meta := make([dynamic]Str_Pair)
	append(&meta, Str_Pair{"author", message.author}, Str_Pair{"text", message.text}, Str_Pair{"ts", "100"}, Str_Pair{"reactions", "{\"like\":[\"device-b\"]}"})
	legacy := Block{id = message.id, content = {kind = .Custom, custom = {content_type = "chat", meta = meta}}}
	request := params({"object_id", source}, {"target_id", root_id})
	request["position"] = json.Integer(POS_INNER)
	request["block"] = block_to_json(legacy)
	_, legacy_error := apply(&v, "block_add", request)
	testing.expect(t, legacy_error == "", legacy_error)
	mismatch := message
	mismatch.text = "different history"
	_, mismatch_error := mail_send(&v, mismatch)
	testing.expect(t, mismatch_error != "", "historical import cannot overwrite unrelated history")
	_, convert_error := mail_send(&v, message)
	testing.expect(t, convert_error == "", convert_error)
	// Another participant may already hold the same shared legacy thread.
	// Convert in place there too, without deleting the source first.
	root_request := params({"object_id", target})
	root_request["block"] = block_to_json(Block{id = root_id, content = {kind = .Custom, custom = {content_type = "discussion", data = encode_conversation(Conversation{id = root_id, kind = .Agent_To_Agent})}}})
	_, root_error := apply(&v, "block_add", root_request)
	testing.expect(t, root_error == "", root_error)
	request["object_id"] = json.String(target)
	_, receiver_legacy_error := apply(&v, "block_add", request)
	testing.expect(t, receiver_legacy_error == "", receiver_legacy_error)
	_, deliver_error := mail_deliver(&v, message, target)
	testing.expect(t, deliver_error == "", deliver_error)
	received, block, _ := message_load(state_of(&v, target), message.id)
	testing.expect_value(t, message_meta(block, "reactions"), "{\"like\":[\"device-b\"]}")
	testing.expect_value(t, message_status(state_of(&v, target), received, "").status, "processed")
	before := len(v.changes)
	claim, claim_error := mail_process(&v, target, message.id, "processing", "must-not-wake")
	testing.expect(t, claim_error == "", claim_error)
	claimed, _ := json_bool(claim, "claimed")
	testing.expect(t, !claimed, "history must never be claimed for processing")
	_, _ = apply(&v, "message_retry", params({"object_id", target}, {"message_id", message.id}, {"stage", "processing"}))
	_, duplicate_error := mail_send(&v, message)
	testing.expect(t, duplicate_error == "", duplicate_error)
	testing.expect_value(t, len(v.changes), before)
	testing.expect_value(t, conversation_message_count(state_of(&v, source), root_id), 1)
}
