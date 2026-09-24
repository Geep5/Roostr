package core

// Immutable envelopes are copied between object DAGs. Delivery and processing
// receipts live below each envelope, never inside its signed/canonical bytes.
import "core:encoding/base64"
import "core:encoding/json"
import "core:fmt"
import "core:slice"
import "core:strings"
import "core:strconv"

Agent_Endpoint :: struct {
	object_id: string,
	agent_id: string,
	unknown: [dynamic]byte,
}

Agent_Message :: struct {
	id: string,
	exchange_id: string,
	sender: Agent_Endpoint,
	recipients: [dynamic]Agent_Endpoint,
	text: string,
	reply_to: string,
	sent_at: i64,
	title: string,
	request_reply: bool,
	historical: bool,
	operation: string,
	author: string,
	unknown: [dynamic]byte,
}

decode_agent_endpoint :: proc(data: []byte, allocator := context.allocator) -> (Agent_Endpoint, bool) {
	out: Agent_Endpoint
	out.unknown = make([dynamic]byte, allocator)
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		start := r.pos
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		if field == 0 || (field <= 2 && wire != 2) do return out, false
		switch field {
		case 1: out.object_id = read_string(&r)
		case 2: out.agent_id = read_string(&r)
		case:
			skip_field(&r, wire)
			if !r.err do append(&out.unknown, ..data[start:r.pos])
		}
	}
	return out, !r.err
}

encode_agent_endpoint :: proc(e: Agent_Endpoint, allocator := context.allocator) -> []byte {
	w := Writer{buf = make([dynamic]byte, allocator)}
	write_string_field(&w, 1, e.object_id)
	write_string_field(&w, 2, e.agent_id)
	append(&w.buf, ..e.unknown[:])
	return w.buf[:]
}

decode_agent_message :: proc(data: []byte, allocator := context.allocator) -> (Agent_Message, bool) {
	out: Agent_Message
	out.recipients = make([dynamic]Agent_Endpoint, allocator)
	out.unknown = make([dynamic]byte, allocator)
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		start := r.pos
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		if field == 0 do return out, false
		if field <= 12 {
			expected: u64 = 2
			if field == 7 || field == 9 || field == 10 do expected = 0
			if wire != expected do return out, false
		}
		switch field {
		case 1: out.id = read_string(&r)
		case 2: out.exchange_id = read_string(&r)
		case 3:
			endpoint, ok := decode_agent_endpoint(read_bytes(&r), allocator)
			if !ok do return out, false
			out.sender = endpoint
		case 4:
			endpoint, ok := decode_agent_endpoint(read_bytes(&r), allocator)
			if !ok do return out, false
			append(&out.recipients, endpoint)
		case 5: out.text = read_string(&r)
		case 6: out.reply_to = read_string(&r)
		case 7: out.sent_at = as_i64(read_varint(&r))
		case 8: out.title = read_string(&r)
		case 9: out.request_reply = read_varint(&r) != 0
		case 10: out.historical = read_varint(&r) != 0
		case 11: out.operation = read_string(&r)
		case 12: out.author = read_string(&r)
		case:
			skip_field(&r, wire)
			if !r.err do append(&out.unknown, ..data[start:r.pos])
		}
	}
	return out, !r.err
}

encode_agent_message :: proc(m: Agent_Message, allocator := context.allocator) -> []byte {
	w := Writer{buf = make([dynamic]byte, allocator)}
	write_string_field(&w, 1, m.id)
	write_string_field(&w, 2, m.exchange_id)
	write_len_prefixed(&w, 3, encode_agent_endpoint(m.sender, allocator))
	for endpoint in m.recipients do write_len_prefixed(&w, 4, encode_agent_endpoint(endpoint, allocator))
	write_string_field(&w, 5, m.text)
	write_string_field(&w, 6, m.reply_to)
	write_i64_field(&w, 7, m.sent_at)
	write_string_field(&w, 8, m.title)
	write_bool_field(&w, 9, m.request_reply)
	write_bool_field(&w, 10, m.historical)
	write_string_field(&w, 11, m.operation)
	write_string_field(&w, 12, m.author)
	append(&w.buf, ..m.unknown[:])
	return w.buf[:]
}

agent_endpoint_to_json :: proc(e: Agent_Endpoint, allocator := context.temp_allocator) -> json.Value {
	out := jobj(allocator)
	out["objectId"] = json.String(e.object_id)
	out["agentId"] = json.String(e.agent_id)
	if len(e.unknown) > 0 do out["unknown"] = json.String(base64.encode(e.unknown[:], allocator = allocator))
	return json.Object(out)
}

agent_message_to_json :: proc(m: Agent_Message, allocator := context.temp_allocator) -> json.Value {
	out := jobj(allocator)
	out["id"] = json.String(m.id)
	out["exchangeId"] = json.String(m.exchange_id)
	out["sender"] = agent_endpoint_to_json(m.sender, allocator)
	recipients := make([dynamic]json.Value, allocator)
	for e in m.recipients do append(&recipients, agent_endpoint_to_json(e, allocator))
	out["recipients"] = json.Array(recipients)
	out["text"] = json.String(m.text)
	out["replyTo"] = json.String(m.reply_to)
	out["sentAt"] = json.Integer(m.sent_at)
	out["title"] = json.String(m.title)
	out["requestReply"] = json.Boolean(m.request_reply)
	out["historical"] = json.Boolean(m.historical)
	out["operation"] = json.String(m.operation)
	out["author"] = json.String(m.author)
	if len(m.unknown) > 0 do out["unknown"] = json.String(base64.encode(m.unknown[:], allocator = allocator))
	return json.Object(out)
}

// Unknown bytes may not override known fields after encoding. Malformed base64
// or protobuf is an error, rather than a lossy successful import.
message_unknown_from_json :: proc(v: json.Value, max_known: u64) -> ([dynamic]byte, bool) {
	out := make([dynamic]byte, context.temp_allocator)
	value, present := json_field(v, "unknown")
	if !present do return out, true
	text, valid := value.(json.String)
	if !valid do return out, false
	data, ok := bytes_from_base64(string(text), context.temp_allocator)
	if !ok do return out, false
	r := Reader{data = data}
	for r.pos < len(data) && !r.err {
		tag := read_varint(&r)
		if tag >> 3 <= max_known do return out, false
		skip_field(&r, tag & 7)
	}
	if r.err do return out, false
	append(&out, ..data)
	return out, true
}

agent_endpoint_from_json :: proc(v: json.Value) -> (Agent_Endpoint, bool) {
	out: Agent_Endpoint
	obj, ok := v.(json.Object)
	if !ok do return out, false
	for key, value in obj {
		if key != "objectId" && key != "agentId" && key != "unknown" do return out, false
		if _, valid := value.(json.String); !valid do return out, false
	}
	out.object_id = json_str(v, "objectId")
	out.agent_id = json_str(v, "agentId")
	out.unknown, ok = message_unknown_from_json(v, 2)
	return out, ok && out.object_id != ""
}

agent_message_from_json :: proc(v: json.Value) -> (Agent_Message, bool) {
	out: Agent_Message
	obj, ok := v.(json.Object)
	if !ok do return out, false
	for key, value in obj {
		switch key {
		case "id", "exchangeId", "text", "replyTo", "title", "operation", "author", "unknown":
			if _, valid := value.(json.String); !valid do return out, false
		case "sender", "recipients":
		case "sentAt":
			// Milliseconds must survive JSON and protobuf without rounding.
			number, valid := json_int(v, key)
			if !valid || number < 0 || number > 9007199254740991 do return out, false
			if f, floating := value.(json.Float); floating && f64(number) != f64(f) do return out, false
		case "requestReply", "historical":
			if _, valid := value.(json.Boolean); !valid do return out, false
		case: return out, false
		}
	}
	out.id = json_str(v, "id")
	out.exchange_id = json_str(v, "exchangeId")
	sender, _ := json_field(v, "sender")
	out.sender, ok = agent_endpoint_from_json(sender)
	if !ok do return out, false
	recipients_value, _ := json_field(v, "recipients")
	recipients, valid := recipients_value.(json.Array)
	if !valid do return out, false
	out.recipients = make([dynamic]Agent_Endpoint, context.temp_allocator)
	for item in recipients {
		endpoint, endpoint_ok := agent_endpoint_from_json(item)
		if !endpoint_ok do return out, false
		append(&out.recipients, endpoint)
	}
	out.text = json_str(v, "text")
	out.reply_to = json_str(v, "replyTo")
	out.sent_at, ok = json_int(v, "sentAt")
	if !ok do return out, false
	out.title = json_str(v, "title")
	out.request_reply, _ = json_bool(v, "requestReply")
	out.historical, _ = json_bool(v, "historical")
	out.operation = json_str(v, "operation")
	out.author = json_str(v, "author")
	out.unknown, ok = message_unknown_from_json(v, 12)
	return out, ok
}

message_block :: proc(s: ^Object_State, id: string) -> ^Block {
	if s != nil {
		for i in 0 ..< len(s.blocks) do if s.blocks[i].id == id do return &s.blocks[i]
	}
	return nil
}

message_child :: proc(s: ^Object_State, parent_id, child_id: string) -> bool {
	parent := message_block(s, parent_id)
	if parent == nil do return false
	for id in parent.children_ids do if id == child_id do return true
	return false
}

message_meta :: proc(b: ^Block, key: string) -> string {
	if b != nil do for pair in b.content.custom.meta do if pair.key == key do return pair.value
	return ""
}

message_recipient :: proc(m: Agent_Message, object_id: string) -> (Agent_Endpoint, bool) {
	for e in m.recipients do if e.object_id == object_id do return e, true
	return {}, false
}

message_load :: proc(s: ^Object_State, id: string) -> (Agent_Message, ^Block, string) {
	if s == nil || s.deleted do return {}, nil, "live object required"
	b := message_block(s, id)
	if b == nil || b.content.kind != .Custom || b.content.custom.content_type != "agent_message" do return {}, nil, "message not found"
	m, ok := decode_agent_message(b.content.custom.data, context.temp_allocator)
	if !ok || m.id != id || m.exchange_id == "" do return {}, nil, "invalid message envelope"
	if !message_child(s, conversation_root_id(m.exchange_id, context.temp_allocator), id) do return {}, nil, "message is outside its exchange"
	return m, b, ""
}

Message_Status :: struct {
	status: string,
	owner: string,
	error: string,
	at: i64,
}

message_status_id :: proc(message_id, recipient_id: string) -> string {
	if recipient_id == "" do return fmt.tprintf("__message_status__%d:%s:processing", len(message_id), message_id)
	return fmt.tprintf("__message_status__%d:%s:delivery:%s", len(message_id), message_id, recipient_id)
}

message_status :: proc(s: ^Object_State, m: Agent_Message, recipient_id: string) -> Message_Status {
	out := Message_Status{status = "pending"}
	if m.historical && recipient_id == "" do out.status = "processed"
	id := message_status_id(m.id, recipient_id)
	if !message_child(s, m.id, id) do return out
	b := message_block(s, id)
	if b == nil do return out
	kind := recipient_id == "" ? "message_processing" : "message_delivery"
	if b.content.kind != .Custom || b.content.custom.content_type != kind do return out
	out.status = message_meta(b, "status")
	out.owner = message_meta(b, "owner")
	out.error = message_meta(b, "error")
	out.at, _ = strconv.parse_i64(message_meta(b, "at"))
	if m.historical && recipient_id == "" do out.status = "processed"
	return out
}

object_mailbox :: proc(s: ^Object_State, allocator := context.temp_allocator) -> [dynamic]json.Value {
	out := make([dynamic]json.Value, allocator)
	if s == nil do return out
	for &b in s.blocks {
		if b.content.kind != .Custom || b.content.custom.content_type != "agent_message" do continue
		m, ok := decode_agent_message(b.content.custom.data, allocator)
		if !ok || m.id != b.id || m.exchange_id == "" do continue
		root_id := conversation_root_id(m.exchange_id, allocator)
		if !message_child(s, root_id, m.id) do continue
		_, incoming := message_recipient(m, s.id)
		outgoing := m.sender.object_id == s.id
		if !incoming && !outgoing do continue
		row := jobj(allocator)
		row["message"] = agent_message_to_json(m, allocator)
		row["threadId"] = json.String(root_id)
		row["incoming"] = json.Boolean(incoming)
		row["outgoing"] = json.Boolean(outgoing)
		deliveries := make([dynamic]json.Value, allocator)
		if outgoing do for e in m.recipients {
			status := message_status(s, m, e.object_id)
			delivery := jobj(allocator)
			delivery["recipient"] = agent_endpoint_to_json(e, allocator)
			delivery["status"] = json.String(status.status)
			delivery["error"] = json.String(status.error)
			delivery["at"] = json.Integer(status.at)
			append(&deliveries, json.Object(delivery))
		}
		row["deliveries"] = json.Array(deliveries)
		status := message_status(s, m, "")
		processing := jobj(allocator)
		processing["status"] = json.String(status.status)
		processing["owner"] = json.String(status.owner)
		processing["error"] = json.String(status.error)
		processing["at"] = json.Integer(status.at)
		row["processing"] = json.Object(processing)
		append(&out, json.Object(row))
	}
	return out
}

message_space :: proc(s: ^Object_State) -> string {
	if s == nil do return ""
	if s.type_key == "channel" do return s.id
	return field_string(s.fields, "channel")
}

message_service_reply_to :: proc(source: ^Object_State, object_id, reply_to: string) -> bool {
	if source == nil || source.type_key != "install" || message_space(source) != "" || reply_to == "" do return false
	request, _, err := message_load(source, reply_to)
	if err != "" || request.operation == "" do return false
	_, addressed := message_recipient(request, source.id)
	if !addressed do return false
	if request.sender.object_id == object_id do return true
	_, member := message_recipient(request, object_id)
	return member
}

message_endpoint_error :: proc(e: Agent_Endpoint, states: map[string]^Object_State, source: ^Object_State, sender: bool, operation, reply_to: string) -> string {
	target := states[e.object_id]
	if target != nil {
		if target.deleted do return "endpoint object is deleted"
		if message_space(target) != message_space(source) {
			service_request := !sender && operation != "" && target.type_key == "install" && message_space(target) == ""
			service_reply := !sender && operation == "" && message_service_reply_to(source, e.object_id, reply_to)
			if !service_request && !service_reply do return "message endpoints must belong to the same space"
		}
		if !sender && operation != "" && target.type_key != "install" do return "operation recipient must be an installation object"
	}
	if !sender && operation != "" && e.agent_id != "" do return "operation recipient must address the installation itself"
	if e.agent_id == "" do return ""
	agent := states[e.agent_id]
	if agent == nil {
		if sender do return "sender agent not found"
		return "" // A not-yet-synced endpoint may remain pending.
	}
	if agent.deleted || agent.type_key != "agent" do return "endpoint agent must be a live agent"
	// An agent speaks for its own object, its space (space_default), or any
	// object whose guest list (`object.agent`) names it.
	subject := field_string(agent.fields, "space_default")
	if subject == "" do subject = agent.id
	if subject != e.object_id && (target == nil || !object_names_agent(target.fields, agent.id)) do return "agent does not belong to endpoint object"
	if message_space(agent) != message_space(source) && !(operation == "" && !sender && message_service_reply_to(source, e.object_id, reply_to)) do return "endpoint agent must belong to the same space"
	return ""
}

message_validate :: proc(m: Agent_Message, states: map[string]^Object_State, object_id: string) -> string {
	source := states[object_id]
	if source == nil || source.deleted do return "live source object required"
	if m.id == "" || m.exchange_id == "" do return "message id and exchangeId required"
	if m.id == conversation_root_id(m.exchange_id, context.temp_allocator) do return "message id collides with exchange root"
	if m.sender.object_id != object_id do return "sender object must match object_id"
	if len(m.recipients) == 0 do return "message recipients required"
	if m.reply_to == m.id do return "message cannot reply to itself"
	if m.historical && m.request_reply do return "historical messages cannot request replies"
	switch m.operation {
	case "", "skill.install", "skill.enable", "skill.disable", "skill.uninstall", "auth.login", "auth.check", "auth.revoke", "auth.save":
	case: return "unsupported message operation"
	}
	if err := message_endpoint_error(m.sender, states, source, true, m.operation, m.reply_to); err != "" do return err
	if m.sender.agent_id != "" && m.author != m.sender.agent_id do return "message author must match sender agent"
	seen := make(map[string]bool, context.temp_allocator)
	for e in m.recipients {
		if e.object_id == "" do return "recipient objectId required"
		if seen[e.object_id] do return "duplicate recipient object"
		seen[e.object_id] = true
		// The sender's own object is a valid recipient only for ANOTHER agent on
		// its guest list (co-guests share one DAG: the outbox copy is the inbox).
		if m.sender.agent_id != "" && e.object_id == object_id && (e.agent_id == "" || e.agent_id == m.sender.agent_id) do return "agent sender cannot target its own object"
		if err := message_endpoint_error(e, states, source, false, m.operation, m.reply_to); err != "" do return err
	}
	return ""
}

// Historical imports alone may convert matching legacy content in place. The
// root/source must remain durable until every recipient has verified its copy.
message_legacy_match :: proc(s: ^Object_State, b: ^Block, m: Agent_Message) -> bool {
	if !m.historical || b == nil || b.content.kind != .Custom || b.content.custom.content_type != "chat" do return false
	if !message_child(s, conversation_root_id(m.exchange_id, context.temp_allocator), m.id) do return false
	ts, ok := strconv.parse_i64(message_meta(b, "ts"))
	return ok && ts == m.sent_at && message_meta(b, "author") == m.author && message_meta(b, "text") == m.text && message_meta(b, "replyTo") == m.reply_to
}

message_clone_meta :: proc(meta: [dynamic]Str_Pair) -> [dynamic]Str_Pair {
	out := make([dynamic]Str_Pair, context.temp_allocator)
	for pair in meta do append(&out, Str_Pair{key = strings.clone(pair.key, context.temp_allocator), value = strings.clone(pair.value, context.temp_allocator)})
	return out
}

message_append :: proc(plan: ^Mutation_Plan, input: Mutation_Input, s: ^Object_State, m: Agent_Message, data: []byte, metadata: [dynamic]Str_Pair = nil) -> string {
	root_id := conversation_root_id(m.exchange_id, context.temp_allocator)
	root := message_block(s, root_id)
	conversation := Conversation{id = root_id, kind = .Agent_To_Agent, title = m.title, created_at = m.sent_at, opened_by = m.author, participants = make([dynamic]string, context.temp_allocator)}
	if root != nil {
		if root.content.kind != .Custom || root.content.custom.content_type != "discussion" do return "exchange root id collision"
		current, ok := decode_conversation(root.content.custom.data, context.temp_allocator)
		if !ok || current.kind != .Agent_To_Agent || (current.id != "" && current.id != root_id) do return "exchange root id collision"
		conversation = current
	}
	b := message_block(s, m.id)
	convert := message_legacy_match(s, b, m)
	if b != nil && !convert {
		if b.content.kind != .Custom || b.content.custom.content_type != "agent_message" || !slice.equal(b.content.custom.data, data) || !message_child(s, root_id, m.id) do return "message id collision"
		return ""
	}
	ops := make([dynamic]Operation, context.temp_allocator)
	participants := make([dynamic]string, context.temp_allocator)
	append(&participants, m.sender.agent_id == "" ? m.author : m.sender.agent_id)
	for e in m.recipients do if e.agent_id != "" do append(&participants, e.agent_id)
	changed := false
	for participant in participants {
		if participant == "" do continue
		found := false
		for existing in conversation.participants do if existing == participant do found = true
		if !found {
			append(&conversation.participants, participant)
			changed = true
		}
	}
	if root == nil || changed {
		root_content := Block_Content{kind = .Custom, custom = {content_type = "discussion", data = encode_conversation(conversation, context.temp_allocator)}}
		if root == nil do append(&ops, Operation{kind = .Block_Add, block = {id = root_id, content = root_content}, position = 0})
		else {
			root_content.custom.meta = message_clone_meta(root.content.custom.meta)
			append(&ops, Operation{kind = .Block_Update, block_id = root_id, content = root_content})
		}
	}
	stored_metadata := metadata
	if convert {
		// Keep receiver-specific reactions; merge metadata not already present.
		merged := make([dynamic]Str_Pair, context.temp_allocator)
		append(&merged, ..b.content.custom.meta[:])
		for pair in metadata {
			found := false
			for old in merged do if old.key == pair.key do found = true
			if !found do append(&merged, pair)
		}
		stored_metadata = merged
	}
	content := Block_Content{kind = .Custom, custom = {content_type = "agent_message", data = data, meta = message_clone_meta(stored_metadata)}}
	if convert do append(&ops, Operation{kind = .Block_Update, block_id = m.id, content = content})
	else do append(&ops, Operation{kind = .Block_Add, block = {id = m.id, content = content}, target_id = root_id, position = POS_INNER})
	mutation_add(plan, input, strings.clone(s.id, context.temp_allocator), ops[:])
	return ""
}

message_write_status :: proc(plan: ^Mutation_Plan, input: Mutation_Input, s: ^Object_State, m: Agent_Message, recipient_id: string, status: Message_Status) -> string {
	id := message_status_id(m.id, recipient_id)
	kind := recipient_id == "" ? "message_processing" : "message_delivery"
	b := message_block(s, id)
	if b != nil && (b.content.kind != .Custom || b.content.custom.content_type != kind || !message_child(s, m.id, id)) do return "message status id collision"
	current := message_status(s, m, recipient_id)
	if current.status == status.status && current.owner == status.owner && current.error == status.error do return ""
	meta := make([dynamic]Str_Pair, context.temp_allocator)
	append(&meta, Str_Pair{key = "status", value = status.status}, Str_Pair{key = "owner", value = status.owner}, Str_Pair{key = "error", value = status.error}, Str_Pair{key = "at", value = fmt.tprintf("%d", input.timestamp)})
	content := Block_Content{kind = .Custom, custom = {content_type = kind, meta = meta}}
	object_id := strings.clone(s.id, context.temp_allocator)
	if b == nil do mutation_add(plan, input, object_id, {Operation{kind = .Block_Add, block = {id = id, content = content}, target_id = strings.clone(m.id, context.temp_allocator), position = POS_INNER}})
	else do mutation_add(plan, input, object_id, {Operation{kind = .Block_Update, block_id = id, content = content}})
	return ""
}

message_mutation :: proc(plan: ^Mutation_Plan, parsed: json.Value, input: Mutation_Input) -> string {
	action := json_str(parsed, "action")
	object_id := json_str(parsed, "object_id")
	if action == "message_send" {
		value, _ := json_field(parsed, "message")
		m, valid := agent_message_from_json(value)
		if !valid do return "invalid message envelope"
		if m.author == "" {
			m.author = m.sender.agent_id
			if m.author == "" do m.author = input.author
		}
		if err := message_validate(m, input.states, object_id); err != "" do return err
		if err := message_append(plan, input, input.states[object_id], m, encode_agent_message(m, context.temp_allocator)); err != "" do return err
		plan.result["id"] = json.String(m.id)
		plan.result["exchangeId"] = json.String(m.exchange_id)
		plan.result["threadId"] = json.String(conversation_root_id(m.exchange_id, context.temp_allocator))
		return ""
	}
	if action == "message_deliver" do object_id = json_str(parsed, "sender_object_id")
	s := input.states[object_id]
	m, block, load_error := message_load(s, json_str(parsed, "message_id"))
	if load_error != "" do return load_error
	recipient_id := json_str(parsed, "recipient_object_id")
	if action == "message_deliver" || action == "message_delivery_error" || (action == "message_retry" && json_str(parsed, "stage") == "delivery") {
		if m.sender.object_id != object_id do return "delivery receipt belongs to sender object"
		endpoint, found := message_recipient(m, recipient_id)
		if !found do return "target is not a message recipient"
		current := message_status(s, m, recipient_id)
		switch action {
		case "message_deliver":
			target := input.states[recipient_id]
			if target == nil || target.deleted do return "live recipient object required"
			if err := message_endpoint_error(endpoint, input.states, s, false, m.operation, m.reply_to); err != "" do return err
			// Canonical sender bytes, NOT any envelope supplied by the caller.
			// Commit order is significant: receipt means receiver DAG recorded it.
			data := make([]byte, len(block.content.custom.data), context.temp_allocator)
			copy(data, block.content.custom.data)
			owned, _ := decode_agent_message(data, context.temp_allocator)
			if err := message_append(plan, input, target, owned, data, block.content.custom.meta); err != "" do return err
			return message_write_status(plan, input, s, m, recipient_id, Message_Status{status = "delivered"})
		case "message_delivery_error":
			if current.status == "delivered" do return ""
			return message_write_status(plan, input, s, m, recipient_id, Message_Status{status = "failed", error = json_str(parsed, "error")})
		case "message_retry":
			if current.status != "failed" do return ""
			return message_write_status(plan, input, s, m, recipient_id, Message_Status{status = "pending"})
		}
	}
	_, incoming := message_recipient(m, object_id)
	if !incoming do return "processing belongs to recipient object"
	current := message_status(s, m, "")
	if action == "message_retry" {
		if json_str(parsed, "stage") != "processing" do return "stage must be delivery or processing"
		if m.historical || current.status != "failed" do return ""
		return message_write_status(plan, input, s, m, "", Message_Status{status = "pending"})
	}
	status := json_str(parsed, "status")
	owner := json_str(parsed, "owner")
	plan.result["claimed"] = json.Boolean(false)
	if m.historical do return ""
	switch status {
	case "processing":
		if owner == "" do return "processing owner required"
		if current.status != "pending" && current.status != "awaiting_approval" do return ""
		if err := message_write_status(plan, input, s, m, "", Message_Status{status = "processing", owner = owner}); err != "" do return err
		plan.result["claimed"] = json.Boolean(true)
		return ""
	case "awaiting_approval":
		if m.operation == "" do return "only capability operations await approval"
		if current.status != "pending" do return ""
		return message_write_status(plan, input, s, m, "", Message_Status{status = "awaiting_approval"})
	case "processed", "failed":
		if owner == "" || owner != current.owner do return "processing owner mismatch"
		if current.status == status && current.error == json_str(parsed, "error") do return ""
		if current.status != "processing" do return "processing status is terminal; retry failed messages explicitly"
		return message_write_status(plan, input, s, m, "", Message_Status{status = status, owner = owner, error = json_str(parsed, "error")})
	case: return "invalid processing status"
	}
	return "unknown message action"
}
