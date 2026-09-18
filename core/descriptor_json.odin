package core

// The JSON face of the descriptor and conversation codecs.
//
// Hosts reach this through the one shared core (`dispatch` -> "descriptor"),
// so a client renders a setup form, or names a thread's participants, without
// carrying its own protobuf reader. That is the whole point of the schema:
// the knowledge travels as data, and exactly one implementation reads it.
//
// Unknown fields survive the JSON boundary too, carried as `unknown` base64.
// A host that decodes, edits and re-encodes a descriptor written by a newer
// client must not silently drop what it could not name.

import "core:encoding/base64"
import "core:encoding/json"

descriptor_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	action := json_str(payload, "action")
	kind := json_str(payload, "type")
	if kind == "" do kind = "descriptor"
	switch action {
	case "decode":
		bytes, bytes_ok := bytes_from_base64(json_str(payload, "bytes"), context.temp_allocator)
		if !bytes_ok do return nil, "invalid base64 payload"
		switch kind {
		case "descriptor":
			value, ok := decode_descriptor(bytes, context.temp_allocator)
			if !ok do return nil, "invalid descriptor"
			return descriptor_to_json(value), ""
		case "installation":
			value, ok := decode_installation(bytes, context.temp_allocator)
			if !ok do return nil, "invalid installation"
			return installation_to_json(value), ""
		case "conversation":
			value, ok := decode_conversation(bytes, context.temp_allocator)
			if !ok do return nil, "invalid conversation"
			return conversation_to_json(value), ""
		}
		return nil, "unknown descriptor type"
	case "encode":
		value, has_value := json_field(payload, "value")
		if !has_value do return nil, "value required"
		switch kind {
		case "descriptor":
			return json.String(base64.encode(encode_descriptor(descriptor_from_json(value), context.temp_allocator), allocator = context.temp_allocator)), ""
		case "installation":
			return json.String(base64.encode(encode_installation(installation_from_json(value), context.temp_allocator), allocator = context.temp_allocator)), ""
		case "conversation":
			return json.String(base64.encode(encode_conversation(conversation_from_json(value), context.temp_allocator), allocator = context.temp_allocator)), ""
		}
		return nil, "unknown descriptor type"
	}
	return nil, "unknown descriptor action"
}

// ── model → JSON ─────────────────────────────────────────────────────

@(private = "file")
put_unknown :: proc(out: ^map[string]json.Value, unknown: [dynamic]byte) {
	if len(unknown) == 0 do return
	out^["unknown"] = json.String(base64.encode(unknown[:], allocator = context.temp_allocator))
}

descriptor_to_json :: proc(d: Descriptor) -> json.Value {
	out := jobj()
	out["key"] = json.String(d.key)
	out["name"] = json.String(d.name)
	out["description"] = json.String(d.description)
	out["kind"] = json.String(descriptor_kind_key(d.kind))
	fields := make([dynamic]json.Value, context.temp_allocator)
	for f in d.fields {
		spec := jobj()
		spec["key"] = json.String(f.key)
		spec["label"] = json.String(f.label)
		spec["secret"] = json.Boolean(f.secret)
		spec["format"] = json.String(field_format_key(f.format))
		spec["note"] = json.String(f.note)
		put_unknown(&spec, f.unknown)
		append(&fields, json.Object(spec))
	}
	out["fields"] = json.Array(fields)
	auths := make([dynamic]json.Value, context.temp_allocator)
	for a in d.auths do append(&auths, json.String(auth_method_key(a)))
	out["auths"] = json.Array(auths)
	if d.has_check {
		check := jobj()
		check["command"] = json.String(d.check.command)
		check["expectContains"] = json.String(d.check.expect_contains)
		check["timeoutMs"] = json.Integer(d.check.timeout_ms)
		put_unknown(&check, d.check.unknown)
		out["check"] = json.Object(check)
	}
	if d.has_install {
		install := jobj()
		install["prompt"] = json.String(d.install.prompt)
		install["uninstallPrompt"] = json.String(d.install.uninstall_prompt)
		install["docsUrl"] = json.String(d.install.docs_url)
		put_unknown(&install, d.install.unknown)
		out["install"] = json.Object(install)
	}
	out["version"] = json.String(d.version)
	out["author"] = json.String(d.author)
	put_unknown(&out, d.unknown)
	return json.Object(out)
}

installation_to_json :: proc(i: Installation) -> json.Value {
	out := jobj()
	out["key"] = json.String(i.key)
	out["machineId"] = json.String(i.machine_id)
	out["status"] = json.String(install_status_key(i.status))
	out["account"] = json.String(i.account)
	out["auth"] = json.String(auth_method_key(i.auth))
	out["checkedAt"] = json.Integer(i.checked_at)
	out["error"] = json.String(i.error)
	put_unknown(&out, i.unknown)
	return json.Object(out)
}

conversation_to_json :: proc(c: Conversation) -> json.Value {
	out := jobj()
	out["id"] = json.String(c.id)
	out["kind"] = json.String(conversation_kind_key(c.kind))
	out["title"] = json.String(c.title)
	participants := make([dynamic]json.Value, context.temp_allocator)
	for p in c.participants do append(&participants, json.String(p))
	out["participants"] = json.Array(participants)
	out["createdAt"] = json.Integer(c.created_at)
	out["openedBy"] = json.String(c.opened_by)
	out["aboutMessageId"] = json.String(c.about_message_id)
	out["closed"] = json.Boolean(c.closed)
	put_unknown(&out, c.unknown)
	return json.Object(out)
}

// ── JSON → model ─────────────────────────────────────────────────────

@(private = "file")
read_unknown :: proc(v: json.Value) -> [dynamic]byte {
	out := make([dynamic]byte, context.temp_allocator)
	text := json_str(v, "unknown")
	if text == "" do return out
	bytes, ok := bytes_from_base64(text, context.temp_allocator)
	if !ok do return out
	append(&out, ..bytes)
	return out
}

descriptor_from_json :: proc(v: json.Value) -> Descriptor {
	out: Descriptor
	out.key = json_str(v, "key")
	out.name = json_str(v, "name")
	out.description = json_str(v, "description")
	out.kind = descriptor_kind_from_key(json_str(v, "kind"))
	out.fields = make([dynamic]Field_Spec, context.temp_allocator)
	for item in json_array(v, "fields") {
		spec: Field_Spec
		spec.key = json_str(item, "key")
		spec.label = json_str(item, "label")
		spec.secret, _ = json_bool(item, "secret")
		spec.format = field_format_from_key(json_str(item, "format"))
		spec.note = json_str(item, "note")
		spec.unknown = read_unknown(item)
		append(&out.fields, spec)
	}
	out.auths = make([dynamic]Auth_Method, context.temp_allocator)
	for item in json_array(v, "auths") {
		if s, ok := item.(json.String); ok {
			method := auth_method_from_key(string(s))
			if method != .Unspecified do append(&out.auths, method)
		}
	}
	if check, ok := json_field(v, "check"); ok {
		out.has_check = true
		out.check.command = json_str(check, "command")
		out.check.expect_contains = json_str(check, "expectContains")
		out.check.timeout_ms, _ = json_int(check, "timeoutMs")
		out.check.unknown = read_unknown(check)
	}
	if install, ok := json_field(v, "install"); ok {
		out.has_install = true
		out.install.prompt = json_str(install, "prompt")
		out.install.uninstall_prompt = json_str(install, "uninstallPrompt")
		out.install.docs_url = json_str(install, "docsUrl")
		out.install.unknown = read_unknown(install)
	}
	out.version = json_str(v, "version")
	out.author = json_str(v, "author")
	out.unknown = read_unknown(v)
	return out
}

installation_from_json :: proc(v: json.Value) -> Installation {
	out: Installation
	out.key = json_str(v, "key")
	out.machine_id = json_str(v, "machineId")
	out.status = install_status_from_key(json_str(v, "status"))
	out.account = json_str(v, "account")
	out.auth = auth_method_from_key(json_str(v, "auth"))
	out.checked_at, _ = json_int(v, "checkedAt")
	out.error = json_str(v, "error")
	out.unknown = read_unknown(v)
	return out
}

conversation_from_json :: proc(v: json.Value) -> Conversation {
	out: Conversation
	out.id = json_str(v, "id")
	out.kind = conversation_kind_from_key(json_str(v, "kind"))
	out.title = json_str(v, "title")
	out.participants = make([dynamic]string, context.temp_allocator)
	for item in json_array(v, "participants") {
		if s, ok := item.(json.String); ok do append(&out.participants, string(s))
	}
	out.created_at, _ = json_int(v, "createdAt")
	out.opened_by = json_str(v, "openedBy")
	out.about_message_id = json_str(v, "aboutMessageId")
	out.closed, _ = json_bool(v, "closed")
	out.unknown = read_unknown(v)
	return out
}

// ── Wire keys ────────────────────────────────────────────────────────
//
// Strings, not numbers: a client logs and compares them, and an unknown one
// from a newer writer degrades to "" rather than a wrong meaning.

descriptor_kind_key :: proc(kind: Descriptor_Kind) -> string {
	switch kind {
	case .Skill: return "skill"
	case .Integration: return "integration"
	case .Agent: return "agent"
	case .Unspecified: return ""
	}
	return ""
}

descriptor_kind_from_key :: proc(key: string) -> Descriptor_Kind {
	switch key {
	case "skill": return .Skill
	case "integration": return .Integration
	case "agent": return .Agent
	}
	return .Unspecified
}

field_format_key :: proc(format: Field_Format) -> string {
	switch format {
	case .Text: return "text"
	case .Password: return "password"
	case .Url: return "url"
	case .Email: return "email"
	case .Unspecified: return ""
	}
	return ""
}

field_format_from_key :: proc(key: string) -> Field_Format {
	switch key {
	case "text": return .Text
	case "password": return .Password
	case "url": return .Url
	case "email": return .Email
	}
	return .Unspecified
}

auth_method_key :: proc(method: Auth_Method) -> string {
	switch method {
	case .Browser_Profile: return "browser_profile"
	case .OAuth: return "oauth"
	case .Api_Key: return "api_key"
	case .None: return "none"
	case .Unspecified: return ""
	}
	return ""
}

auth_method_from_key :: proc(key: string) -> Auth_Method {
	switch key {
	case "browser_profile": return .Browser_Profile
	case "oauth": return .OAuth
	case "api_key": return .Api_Key
	case "none": return .None
	}
	return .Unspecified
}

install_status_key :: proc(status: Install_Status) -> string {
	switch status {
	case .Active: return "active"
	case .Needs_Auth: return "needs_auth"
	case .Missing: return "missing"
	case .Broken: return "broken"
	case .Disabled: return "disabled"
	case .Unspecified: return ""
	}
	return ""
}

install_status_from_key :: proc(key: string) -> Install_Status {
	switch key {
	case "active": return .Active
	case "needs_auth": return .Needs_Auth
	case "missing": return .Missing
	case "broken": return .Broken
	case "disabled": return .Disabled
	}
	return .Unspecified
}
