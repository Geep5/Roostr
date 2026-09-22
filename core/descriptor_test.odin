#+build !js
package core

// The descriptor codec's contract. Two properties carry the whole design:
//
//  1. bytes round-trip - what a machine publishes is what a client reads;
//  2. unknown fields SURVIVE - a client older than the descriptor it reads
//     re-emits the parts it cannot name, byte for byte. That is the reason
//     descriptors are protobuf instead of hand-rolled JSON in object fields,
//     so it is tested rather than assumed.

import "core:encoding/base64"
import "core:encoding/json"
import "core:slice"
import "core:testing"

@(test)
descriptor_round_trips :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	d: Descriptor
	d.key = "x"
	d.name = "X (Twitter)"
	d.description = "Post and read as an account you own."
	d.kind = .Integration
	d.version = "1"
	d.author = "npub1fcppsmdf84swh33vqwklscppskw5j8tcu280n27ejlz53lvl5xcqxj0vl2"
	d.fields = make([dynamic]Field_Spec)
	append(&d.fields, Field_Spec{key = "apiKey", label = "API key", format = .Text})
	append(
		&d.fields,
		Field_Spec{key = "apiSecret", label = "API secret", secret = true, format = .Password, note = "Never leaves this machine."},
	)
	d.auths = make([dynamic]Auth_Method)
	append(&d.auths, Auth_Method.Browser_Profile)
	append(&d.auths, Auth_Method.Api_Key)
	d.has_check = true
	d.check = Check_Spec{command = "x-retweet --whoami", expect_contains = "@", timeout_ms = 15000}
	d.has_install = true
	d.install = Install_Spec{prompt = "Log into x.com in a dedicated Chrome profile.", docs_url = "https://x.com"}

	wire := encode_descriptor(d)
	back, ok := decode_descriptor(wire)
	testing.expect(t, ok, "descriptor decodes")
	testing.expect_value(t, back.key, "x")
	testing.expect_value(t, back.name, "X (Twitter)")
	testing.expect_value(t, back.kind, Descriptor_Kind.Integration)
	testing.expect_value(t, back.author, d.author)
	testing.expect_value(t, len(back.fields), 2)
	testing.expect_value(t, back.fields[1].key, "apiSecret")
	testing.expect(t, back.fields[1].secret, "the secret flag survives")
	testing.expect_value(t, back.fields[1].format, Field_Format.Password)
	testing.expect_value(t, len(back.auths), 2)
	testing.expect_value(t, back.auths[0], Auth_Method.Browser_Profile)
	testing.expect_value(t, back.auths[1], Auth_Method.Api_Key)
	testing.expect(t, back.has_check, "check present")
	testing.expect_value(t, back.check.timeout_ms, 15000)
	testing.expect(t, back.has_install, "install present")
	testing.expect_value(t, back.install.docs_url, "https://x.com")

	// Re-encoding a decoded descriptor is byte-identical: content addressing
	// and change dedupe both depend on it.
	again := encode_descriptor(back)
	testing.expect(t, slice.equal(wire, again), "re-encode is byte-identical")
	testing.expect(t, descriptors_equal(d, back), "same card")
}

@(test)
descriptor_defaults_are_omitted :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// proto3 default-omission is what keeps hashes stable across the three
	// implementations; an empty descriptor must be zero bytes.
	empty: Descriptor
	testing.expect_value(t, len(encode_descriptor(empty)), 0)

	just_key: Descriptor
	just_key.key = "browserless"
	wire := encode_descriptor(just_key)
	back, ok := decode_descriptor(wire)
	testing.expect(t, ok, "decodes")
	testing.expect_value(t, back.kind, Descriptor_Kind.Unspecified)
	testing.expect_value(t, len(back.fields), 0)
	testing.expect(t, !back.has_check, "absent check stays absent")
}

@(test)
descriptor_keeps_fields_it_cannot_name :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// A descriptor from a NEWER writer: field 12 (string) and field 13
	// (varint) do not exist in this build's schema, plus field 6 inside a
	// FieldSpec. This build must render what it knows and hand the rest back
	// untouched, or every round trip through an old client is data loss.
	w := Writer{buf = make([dynamic]byte)}
	write_string_field(&w, 1, "future")
	write_string_field(&w, 2, "From next year")
	write_tag(&w, 4, 0)
	write_varint(&w, u64(Descriptor_Kind.Skill))
	inner := Writer{buf = make([dynamic]byte)}
	write_string_field(&inner, 1, "region")
	write_string_field(&inner, 6, "eu-west-1") // unknown inside a nested message
	write_len_prefixed(&w, 5, inner.buf[:])
	write_string_field(&w, 12, "a field this build has never heard of")
	write_tag(&w, 13, 0)
	write_varint(&w, 4242)
	from_future := w.buf[:]

	back, ok := decode_descriptor(from_future)
	testing.expect(t, ok, "unknown fields do not fail the decode")
	testing.expect_value(t, back.key, "future")
	testing.expect_value(t, back.kind, Descriptor_Kind.Skill)
	testing.expect_value(t, len(back.fields), 1)
	testing.expect_value(t, back.fields[0].key, "region")
	testing.expect(t, len(back.unknown) > 0, "unknown top-level bytes captured")
	testing.expect(t, len(back.fields[0].unknown) > 0, "unknown nested bytes captured")

	again := encode_descriptor(back)
	testing.expect(
		t,
		slice.equal(from_future, again),
		"a descriptor from the future survives a round trip through this build",
	)
}

@(test)
descriptor_agent_round_trips :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// An AGENT card carries what the kind IS: prompt, model, and the string
	// lists setup copies onto the agent object. Every list survives both the
	// wire and the JSON hop, or a kind picker would mint agents missing a
	// requirement and `resolve_server` would place them on the wrong machine.
	d: Descriptor
	d.key = "marco"
	d.name = "Marco"
	d.description = "Matcherino dev bot."
	d.kind = .Agent
	d.version = "1"
	d.has_agent = true
	d.agent.system = "You are Marco."
	d.agent.model = "kimi-k2-0905-preview"
	d.agent.requires = make([dynamic]string)
	append(&d.agent.requires, "matcherino-dev")
	append(&d.agent.requires, "discord-bot")
	d.agent.skills = make([dynamic]string)
	append(&d.agent.skills, "matcherino-dev")
	d.agent.responsible_types = make([dynamic]string)
	append(&d.agent.responsible_types, "task")
	append(&d.agent.responsible_types, "bug")

	wire := encode_descriptor(d)
	back, ok := decode_descriptor(wire)
	testing.expect(t, ok, "agent descriptor decodes")
	testing.expect_value(t, back.kind, Descriptor_Kind.Agent)
	testing.expect(t, back.has_agent, "agent present")
	testing.expect_value(t, back.agent.system, "You are Marco.")
	testing.expect_value(t, back.agent.model, "kimi-k2-0905-preview")
	testing.expect_value(t, len(back.agent.requires), 2)
	testing.expect_value(t, back.agent.requires[0], "matcherino-dev")
	testing.expect_value(t, back.agent.requires[1], "discord-bot")
	testing.expect_value(t, len(back.agent.skills), 1)
	testing.expect_value(t, back.agent.skills[0], "matcherino-dev")
	testing.expect_value(t, len(back.agent.responsible_types), 2)
	testing.expect_value(t, back.agent.responsible_types[1], "bug")
	testing.expect(t, !back.has_install, "an agent card has no install spec")
	testing.expect(t, slice.equal(wire, encode_descriptor(back)), "re-encode is byte-identical")

	// JSON hop, through the host ABI: keys are the contract a client reads.
	request := jobj()
	request["action"] = json.String("decode")
	request["type"] = json.String("descriptor")
	request["bytes"] = json.String(base64.encode(wire, allocator = context.temp_allocator))
	decoded, decode_error := dispatch("descriptor", json.Object(request))
	testing.expect_value(t, decode_error, "")
	testing.expect_value(t, json_str(decoded, "kind"), "agent")
	agent, has_agent := json_field(decoded, "agent")
	testing.expect(t, has_agent, "agent object emitted")
	testing.expect_value(t, json_str(agent, "system"), "You are Marco.")
	testing.expect_value(t, json_str(agent, "model"), "kimi-k2-0905-preview")
	testing.expect_value(t, len(json_array(agent, "requires")), 2)
	testing.expect_value(t, len(json_array(agent, "skills")), 1)
	responsible := json_array(agent, "responsibleTypes")
	testing.expect_value(t, len(responsible), 2)
	testing.expect_value(t, string(responsible[0].(json.String)), "task")

	encode_request := jobj()
	encode_request["action"] = json.String("encode")
	encode_request["type"] = json.String("descriptor")
	encode_request["value"] = decoded
	reencoded, encode_error := dispatch("descriptor", json.Object(encode_request))
	testing.expect_value(t, encode_error, "")
	bytes, b64_ok := bytes_from_base64(string(reencoded.(json.String)), context.temp_allocator)
	testing.expect(t, b64_ok, "valid base64")
	testing.expect(t, slice.equal(wire, bytes), "JSON round trip is byte-identical")

	// A non-agent card must not grow an empty `agent` object: the key's
	// presence is how a client tells an agent card from the rest.
	plain: Descriptor
	plain.key = "browserless"
	plain_back, _ := decode_descriptor(encode_descriptor(plain))
	testing.expect(t, !plain_back.has_agent, "absent agent stays absent")
	_, plain_has_agent := json_field(descriptor_to_json(plain_back), "agent")
	testing.expect(t, !plain_has_agent, "no agent key without an agent spec")
}

@(test)
descriptor_agent_keeps_fields_it_cannot_name :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// Field 6 inside AgentSpec is from a newer writer; same guarantee as the
	// nested FieldSpec case, tested on its own because AgentSpec has its own
	// decoder.
	inner := Writer{buf = make([dynamic]byte)}
	write_string_field(&inner, 1, "You are Marco.")
	write_string_field(&inner, 3, "discord-bot")
	write_string_field(&inner, 6, "a kind property from next year")
	w := Writer{buf = make([dynamic]byte)}
	write_string_field(&w, 1, "marco")
	write_tag(&w, 4, 0)
	write_varint(&w, u64(Descriptor_Kind.Agent))
	write_len_prefixed(&w, 11, inner.buf[:])
	from_future := w.buf[:]

	back, ok := decode_descriptor(from_future)
	testing.expect(t, ok, "decodes")
	testing.expect(t, back.has_agent, "agent present")
	testing.expect_value(t, back.agent.system, "You are Marco.")
	testing.expect_value(t, len(back.agent.requires), 1)
	testing.expect(t, len(back.agent.unknown) > 0, "unknown nested bytes captured")
	testing.expect(t, slice.equal(from_future, encode_descriptor(back)), "survives a round trip")

	// And through JSON: `unknown` base64 on the agent object carries it.
	via_json := descriptor_from_json(descriptor_to_json(back))
	testing.expect(t, slice.equal(from_future, encode_descriptor(via_json)), "survives the JSON hop")
}

@(test)
descriptor_unknown_enum_does_not_invent_a_variant :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	w := Writer{buf = make([dynamic]byte)}
	write_string_field(&w, 1, "weird")
	write_tag(&w, 4, 0)
	write_varint(&w, 99) // a DescriptorKind added after this build
	back, ok := decode_descriptor(w.buf[:])
	testing.expect(t, ok, "decodes")
	testing.expect_value(t, back.kind, Descriptor_Kind.Unspecified)
}

@(test)
descriptor_rejects_a_truncated_message :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	d: Descriptor
	d.key = "browserless"
	d.name = "Headless Chrome"
	wire := encode_descriptor(d)
	// A change whose bytes are cut mid-field must be refused, never guessed
	// at - same discipline as the store's quarantine path.
	_, ok := decode_descriptor(wire[:len(wire) - 2])
	testing.expect(t, !ok, "a truncated descriptor is refused")
}

@(test)
installation_round_trips_with_its_error :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// The live holdup this Mac has been sitting on, as an Installation: the
	// text that no view can see today.
	i := Installation {
		key        = "x",
		machine_id = "820d3a06-1eee-4b68-b997-12eb7e44b7fe",
		status     = .Needs_Auth,
		auth       = .Browser_Profile,
		checked_at = 1789603984879,
		error      = `credential "x" has no logged-in browser profile`,
	}
	wire := encode_installation(i)
	back, ok := decode_installation(wire)
	testing.expect(t, ok, "installation decodes")
	testing.expect_value(t, back.key, "x")
	testing.expect_value(t, back.status, Install_Status.Needs_Auth)
	testing.expect_value(t, back.auth, Auth_Method.Browser_Profile)
	testing.expect_value(t, back.checked_at, 1789603984879)
	testing.expect_value(t, back.error, i.error)
	testing.expect(t, slice.equal(wire, encode_installation(back)), "re-encode is byte-identical")

	// A cleared error is an absent field, not the string "none".
	clean := back
	clean.error = ""
	clean.status = .Active
	fixed, _ := decode_installation(encode_installation(clean))
	testing.expect_value(t, fixed.error, "")
	testing.expect_value(t, fixed.status, Install_Status.Active)
}

@(test)
descriptor_json_boundary_preserves_the_future :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// The ABI is JSON, so the compatibility guarantee has to survive TWO
	// hops: bytes -> JSON -> bytes. A host that decodes a newer descriptor,
	// shows it, and writes it back must not strip the parts it cannot name.
	w := Writer{buf = make([dynamic]byte)}
	write_string_field(&w, 1, "x")
	write_string_field(&w, 2, "X (Twitter)")
	write_tag(&w, 4, 0)
	write_varint(&w, u64(Descriptor_Kind.Integration))
	write_string_field(&w, 12, "written by next year's client")
	original := w.buf[:]

	request := jobj()
	request["action"] = json.String("decode")
	request["type"] = json.String("descriptor")
	request["bytes"] = json.String(base64.encode(original, allocator = context.temp_allocator))
	decoded, decode_error := dispatch("descriptor", json.Object(request))
	testing.expect_value(t, decode_error, "")
	testing.expect_value(t, json_str(decoded, "key"), "x")
	testing.expect_value(t, json_str(decoded, "kind"), "integration")
	testing.expect(t, json_str(decoded, "unknown") != "", "unknown bytes reach the host as base64")

	encode_request := jobj()
	encode_request["action"] = json.String("encode")
	encode_request["type"] = json.String("descriptor")
	encode_request["value"] = decoded
	reencoded, encode_error := dispatch("descriptor", json.Object(encode_request))
	testing.expect_value(t, encode_error, "")
	text, is_string := reencoded.(json.String)
	testing.expect(t, is_string, "encode returns base64")
	bytes, ok := bytes_from_base64(string(text), context.temp_allocator)
	testing.expect(t, ok, "valid base64")
	testing.expect(t, slice.equal(original, bytes), "a JSON round trip through this host is byte-identical")
}

@(test)
conversation_json_round_trips_through_the_abi :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// What a client does with the 159 bytes on a thread root.
	c := Conversation {
		id           = "__thread__50706675",
		kind         = .Agent_To_Agent,
		title        = "Pricing research",
		created_at   = 1789700000000,
		opened_by    = "device-a",
		participants = make([dynamic]string),
	}
	append(&c.participants, "agent-scout", "agent-analyst")

	request := jobj()
	request["action"] = json.String("decode")
	request["type"] = json.String("conversation")
	request["bytes"] = json.String(base64.encode(encode_conversation(c), allocator = context.temp_allocator))
	decoded, err := dispatch("descriptor", json.Object(request))
	testing.expect_value(t, err, "")
	testing.expect_value(t, json_str(decoded, "kind"), "a2a")
	testing.expect_value(t, json_str(decoded, "title"), "Pricing research")
	people := json_array(decoded, "participants")
	testing.expect_value(t, len(people), 2)
	testing.expect_value(t, json_str(decoded, "openedBy"), "device-a")

	// And an installation, whose `error` is the whole reason it exists.
	install_request := jobj()
	install_request["action"] = json.String("decode")
	install_request["type"] = json.String("installation")
	broken := Installation{key = "x", status = .Needs_Auth, error = "no logged-in browser profile"}
	install_request["bytes"] = json.String(base64.encode(encode_installation(broken), allocator = context.temp_allocator))
	install_decoded, install_error := dispatch("descriptor", json.Object(install_request))
	testing.expect_value(t, install_error, "")
	testing.expect_value(t, json_str(install_decoded, "status"), "needs_auth")
	testing.expect_value(t, json_str(install_decoded, "error"), "no logged-in browser profile")

	_, unknown_type := dispatch("descriptor", json.Object(params_of("decode", "wat")))
	testing.expect_value(t, unknown_type, "unknown descriptor type")
	_, unknown_action := dispatch("descriptor", json.Object(params_of("frobnicate", "descriptor")))
	testing.expect_value(t, unknown_action, "unknown descriptor action")
}

@(private = "file")
params_of :: proc(action, kind: string) -> map[string]json.Value {
	out := jobj()
	out["action"] = json.String(action)
	out["type"] = json.String(kind)
	out["bytes"] = json.String("")
	return out
}
