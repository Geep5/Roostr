package core

// Descriptors: things describing themselves.
//
// A client should be able to open a vault it has never seen and know how to
// work it, without a compiled-in table of knowledge. `Descriptor` is that
// card - what exists, what inputs it needs, how a machine checks it - and it
// travels as protobuf bytes inside an object.
//
// The codec lives HERE, once, because every host reaches the shared core:
// duplicating it in TypeScript and Swift is exactly how the hand-copied
// capability lists drifted (`website/src/lib/serving.ts` still carries a
// comment admitting it mirrors the harness catalogs).
//
// Unknown fields are PRESERVED on decode and re-emitted on encode. That is
// the compatibility guarantee the format is chosen for: a client older than
// the descriptor it reads renders what it understands and passes the rest
// through untouched, instead of silently dropping it.

import "core:slice"

Descriptor_Kind :: enum i64 {
	Unspecified = 0,
	Skill       = 1,
	Integration = 2,
	Agent       = 3,
}

Field_Format :: enum i64 {
	Unspecified = 0,
	Text        = 1,
	Password    = 2,
	Url         = 3,
	Email       = 4,
}

Auth_Method :: enum i64 {
	Unspecified     = 0,
	Browser_Profile = 1,
	OAuth           = 2,
	Api_Key         = 3,
	None            = 4,
}

Install_Status :: enum i64 {
	Unspecified = 0,
	Active      = 1,
	Needs_Auth  = 2,
	Missing     = 3,
	Broken      = 4,
}

Field_Spec :: struct {
	key:     string,
	label:   string,
	secret:  bool,
	format:  Field_Format,
	note:    string,
	unknown: [dynamic]byte,
}

Check_Spec :: struct {
	command:         string,
	expect_contains: string,
	timeout_ms:      i64,
	unknown:         [dynamic]byte,
}

Install_Spec :: struct {
	prompt:           string,
	uninstall_prompt: string,
	docs_url:         string,
	unknown:          [dynamic]byte,
}

Descriptor :: struct {
	key:         string,
	name:        string,
	description: string,
	kind:        Descriptor_Kind,
	fields:      [dynamic]Field_Spec,
	auths:       [dynamic]Auth_Method,
	check:       Check_Spec,
	has_check:   bool,
	install:     Install_Spec,
	has_install: bool,
	version:     string,
	author:      string,
	/** Fields this build does not know, kept verbatim so a round trip through
	 *  an older client cannot destroy a newer descriptor. */
	unknown:     [dynamic]byte,
}

Installation :: struct {
	key:        string,
	machine_id: string,
	status:     Install_Status,
	account:    string,
	auth:       Auth_Method,
	checked_at: i64,
	error:      string,
	unknown:    [dynamic]byte,
}

// ── Unknown-field capture ────────────────────────────────────────────

/** Copy the whole field - tag included - so it can be re-emitted verbatim. */
@(private = "file")
keep_unknown :: proc(dst: ^[dynamic]byte, r: ^Reader, tag_start: int) {
	if r.err do return
	append(dst, ..r.data[tag_start:r.pos])
}

/** Unrecognised enum numbers decode as Unspecified - proto3 open-enum rule -
 *  rather than a bogus variant. Written out per enum: no generic reflection. */
@(private = "file")
descriptor_kind_from :: proc(v: i64) -> Descriptor_Kind {
	switch v {
	case 1: return .Skill
	case 2: return .Integration
	case 3: return .Agent
	}
	return .Unspecified
}

@(private = "file")
field_format_from :: proc(v: i64) -> Field_Format {
	switch v {
	case 1: return .Text
	case 2: return .Password
	case 3: return .Url
	case 4: return .Email
	}
	return .Unspecified
}

@(private = "file")
auth_method_from :: proc(v: i64) -> Auth_Method {
	switch v {
	case 1: return .Browser_Profile
	case 2: return .OAuth
	case 3: return .Api_Key
	case 4: return .None
	}
	return .Unspecified
}

@(private = "file")
install_status_from :: proc(v: i64) -> Install_Status {
	switch v {
	case 1: return .Active
	case 2: return .Needs_Auth
	case 3: return .Missing
	case 4: return .Broken
	}
	return .Unspecified
}

// ── Decoders ─────────────────────────────────────────────────────────

decode_field_spec :: proc(data: []byte, allocator := context.allocator) -> Field_Spec {
	context.allocator = allocator
	out: Field_Spec
	out.unknown = make([dynamic]byte, allocator)
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		start := r.pos
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		switch field {
		case 1: out.key = read_string(&r)
		case 2: out.label = read_string(&r)
		case 3: out.secret = read_varint(&r) != 0
		case 4: out.format = field_format_from(as_i64(read_varint(&r)))
		case 5: out.note = read_string(&r)
		case:
			skip_field(&r, wire)
			keep_unknown(&out.unknown, &r, start)
		}
	}
	return out
}

decode_check_spec :: proc(data: []byte, allocator := context.allocator) -> Check_Spec {
	context.allocator = allocator
	out: Check_Spec
	out.unknown = make([dynamic]byte, allocator)
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		start := r.pos
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		switch field {
		case 1: out.command = read_string(&r)
		case 2: out.expect_contains = read_string(&r)
		case 3: out.timeout_ms = as_i64(read_varint(&r))
		case:
			skip_field(&r, wire)
			keep_unknown(&out.unknown, &r, start)
		}
	}
	return out
}

decode_install_spec :: proc(data: []byte, allocator := context.allocator) -> Install_Spec {
	context.allocator = allocator
	out: Install_Spec
	out.unknown = make([dynamic]byte, allocator)
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		start := r.pos
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		switch field {
		case 1: out.prompt = read_string(&r)
		case 2: out.uninstall_prompt = read_string(&r)
		case 3: out.docs_url = read_string(&r)
		case:
			skip_field(&r, wire)
			keep_unknown(&out.unknown, &r, start)
		}
	}
	return out
}

decode_descriptor :: proc(data: []byte, allocator := context.allocator) -> (Descriptor, bool) {
	context.allocator = allocator
	out: Descriptor
	out.fields = make([dynamic]Field_Spec, allocator)
	out.auths = make([dynamic]Auth_Method, allocator)
	out.unknown = make([dynamic]byte, allocator)
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		start := r.pos
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		switch field {
		case 1: out.key = read_string(&r)
		case 2: out.name = read_string(&r)
		case 3: out.description = read_string(&r)
		case 4: out.kind = descriptor_kind_from(as_i64(read_varint(&r)))
		case 5: append(&out.fields, decode_field_spec(read_bytes(&r), allocator))
		case 6:
			// proto3 packs repeated enums; accept both forms.
			if wire == 2 {
				packed := Reader{data = read_bytes(&r)}
				for packed.pos < len(packed.data) && !packed.err {
					append(&out.auths, auth_method_from(as_i64(read_varint(&packed))))
				}
				if packed.err do r.err = true
			} else {
				append(&out.auths, auth_method_from(as_i64(read_varint(&r))))
			}
		case 7:
			out.check = decode_check_spec(read_bytes(&r), allocator)
			out.has_check = true
		case 8:
			out.install = decode_install_spec(read_bytes(&r), allocator)
			out.has_install = true
		case 9: out.version = read_string(&r)
		case 10: out.author = read_string(&r)
		case:
			skip_field(&r, wire)
			keep_unknown(&out.unknown, &r, start)
		}
	}
	return out, !r.err
}

decode_installation :: proc(data: []byte, allocator := context.allocator) -> (Installation, bool) {
	context.allocator = allocator
	out: Installation
	out.unknown = make([dynamic]byte, allocator)
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		start := r.pos
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		switch field {
		case 1: out.key = read_string(&r)
		case 2: out.machine_id = read_string(&r)
		case 3: out.status = install_status_from(as_i64(read_varint(&r)))
		case 4: out.account = read_string(&r)
		case 5: out.auth = auth_method_from(as_i64(read_varint(&r)))
		case 6: out.checked_at = as_i64(read_varint(&r))
		case 7: out.error = read_string(&r)
		case:
			skip_field(&r, wire)
			keep_unknown(&out.unknown, &r, start)
		}
	}
	return out, !r.err
}

// ── Encoders ─────────────────────────────────────────────────────────

@(private = "file")
write_enum_field :: proc(w: ^Writer, field: u64, v: i64) {
	if v == 0 do return // proto3: defaults omitted
	write_tag(w, field, 0)
	write_varint(w, u64(v))
}

@(private = "file")
write_unknown :: proc(w: ^Writer, unknown: [dynamic]byte) {
	if len(unknown) == 0 do return
	append(&w.buf, ..unknown[:])
}

encode_field_spec :: proc(f: Field_Spec, w: ^Writer) {
	write_string_field(w, 1, f.key)
	write_string_field(w, 2, f.label)
	write_bool_field(w, 3, f.secret)
	write_enum_field(w, 4, i64(f.format))
	write_string_field(w, 5, f.note)
	write_unknown(w, f.unknown)
}

encode_check_spec :: proc(c: Check_Spec, w: ^Writer) {
	write_string_field(w, 1, c.command)
	write_string_field(w, 2, c.expect_contains)
	write_i64_field(w, 3, c.timeout_ms)
	write_unknown(w, c.unknown)
}

encode_install_spec :: proc(s: Install_Spec, w: ^Writer) {
	write_string_field(w, 1, s.prompt)
	write_string_field(w, 2, s.uninstall_prompt)
	write_string_field(w, 3, s.docs_url)
	write_unknown(w, s.unknown)
}

encode_descriptor :: proc(d: Descriptor, allocator := context.allocator) -> []byte {
	w := Writer{buf = make([dynamic]byte, allocator)}
	write_string_field(&w, 1, d.key)
	write_string_field(&w, 2, d.name)
	write_string_field(&w, 3, d.description)
	write_enum_field(&w, 4, i64(d.kind))
	for f in d.fields {
		inner := Writer{buf = make([dynamic]byte, context.temp_allocator)}
		encode_field_spec(f, &inner)
		write_len_prefixed(&w, 5, inner.buf[:])
	}
	if len(d.auths) > 0 {
		packed := Writer{buf = make([dynamic]byte, context.temp_allocator)}
		for a in d.auths do write_varint(&packed, u64(a))
		write_len_prefixed(&w, 6, packed.buf[:])
	}
	if d.has_check {
		inner := Writer{buf = make([dynamic]byte, context.temp_allocator)}
		encode_check_spec(d.check, &inner)
		write_len_prefixed(&w, 7, inner.buf[:])
	}
	if d.has_install {
		inner := Writer{buf = make([dynamic]byte, context.temp_allocator)}
		encode_install_spec(d.install, &inner)
		write_len_prefixed(&w, 8, inner.buf[:])
	}
	write_string_field(&w, 9, d.version)
	write_string_field(&w, 10, d.author)
	write_unknown(&w, d.unknown)
	return w.buf[:]
}

encode_installation :: proc(i: Installation, allocator := context.allocator) -> []byte {
	w := Writer{buf = make([dynamic]byte, allocator)}
	write_string_field(&w, 1, i.key)
	write_string_field(&w, 2, i.machine_id)
	write_enum_field(&w, 3, i64(i.status))
	write_string_field(&w, 4, i.account)
	write_enum_field(&w, 5, i64(i.auth))
	write_i64_field(&w, 6, i.checked_at)
	write_string_field(&w, 7, i.error)
	write_unknown(&w, i.unknown)
	return w.buf[:]
}

/** Two descriptors are the same card when their bytes agree. */
descriptors_equal :: proc(a, b: Descriptor) -> bool {
	left := encode_descriptor(a, context.temp_allocator)
	right := encode_descriptor(b, context.temp_allocator)
	return slice.equal(left, right)
}
