#+build !js
package core

// The descriptor codec's contract. Two properties carry the whole design:
//
//  1. bytes round-trip - what a machine publishes is what a client reads;
//  2. unknown fields SURVIVE - a client older than the descriptor it reads
//     re-emits the parts it cannot name, byte for byte. That is the reason
//     descriptors are protobuf instead of hand-rolled JSON in object fields,
//     so it is tested rather than assumed.

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
	// A descriptor from a NEWER writer: field 11 (string) and field 12
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
	write_string_field(&w, 11, "a field this build has never heard of")
	write_tag(&w, 12, 0)
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
