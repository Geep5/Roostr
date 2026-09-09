#+build !js
package core

import "core:encoding/json"
import "core:strings"
import "core:testing"

@(test)
json_depth_ok_balanced_vs_unbalanced :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	cases := []struct { body: string, ok: bool } {
		{`{"a":[1,{"b":2}]}`, true},
		{`{}`, true},
		{`[]`, true},
		{`{"a":[1,{"b":2}]`, false}, // unclosed nesting
		{`[[[[`, false},             // openers never closed
		{`}`, true},                 // surplus closer clamps at zero; parser rejects it later
		{`{"k":"{[((("}`, true},     // brackets inside a string literal do not count
		{`{"k":"\"}"}`, true},       // escaped quote does not end the string
		{`{"k":"\\"}[`, false},      // escaped backslash: string ends, trailing opener unclosed
	}
	for c in cases {
		testing.expect(t, json_depth_ok(transmute([]u8)c.body) == c.ok, c.body)
	}
}

@(test)
json_depth_ok_cap_boundary :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	deep := strings.concatenate({strings.repeat("[", 128, context.temp_allocator), strings.repeat("]", 128, context.temp_allocator)}, context.temp_allocator)
	too_deep := strings.concatenate({strings.repeat("[", 129, context.temp_allocator), strings.repeat("]", 129, context.temp_allocator)}, context.temp_allocator)
	testing.expect(t, json_depth_ok(transmute([]u8)deep, 128), "at the cap")
	testing.expect(t, !json_depth_ok(transmute([]u8)too_deep, 128), "past the cap")
	testing.expect(t, json_depth_ok(transmute([]u8)string(`[[[]]]`), 3), "custom cap at boundary")
	testing.expect(t, !json_depth_ok(transmute([]u8)string(`[[[[]]]]`), 3), "custom cap exceeded")
}

@(test)
value_to_json_clamps_non_finite_floats :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// Bit patterns: quiet NaN, +Inf, -Inf. encoding/json would marshal
	// them as bare NaN/+Inf/-Inf tokens, which is not valid JSON.
	for bits in ([]u64{0x7ff8000000000000, 0x7ff0000000000000, 0xfff0000000000000}) {
		f := transmute(f64)bits
		out := marshal(value_to_json(Value{kind = .Float, f = f}))
		_, err := json.parse(out)
		testing.expect(t, err == nil, "floatValue must stay valid JSON")
		testing.expect(t, strings.contains(string(out), `"floatValue":0`), string(out))
	}
}
