package core

// record_decode / patch_decode invert the canonical encodings: every record
// and patch of the shared merge vectors survives encode -> decode -> encode
// byte for byte, and truncated bytes are refused.

import "core:encoding/json"
import "core:testing"

@(test)
record_decode_round_trips :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	root, err := json.parse(#load("testdata/record_vectors/merge.json"), parse_integers = true)
	testing.expect(t, err == nil, "merge.json parses")
	records, patches := 0, 0
	for item in root.(json.Array) {
		name := json_str(item, "name")
		for rv in json_array(item, "records") {
			r, ok := record_from_json(rv)
			if !ok do continue
			bytes := record_encode(r)
			back, dok := record_decode(bytes)
			testing.expectf(t, dok && string(record_encode(back)) == string(bytes), "%s: record round-trips", name)
			records += 1
			if len(bytes) > 1 {
				cut, cok := record_decode(bytes[:len(bytes) - 1])
				testing.expectf(t, !cok || string(record_encode(cut)) != string(bytes), "%s: a truncated record is not the record", name)
			}
		}
		for pv in json_array(item, "patches") {
			p, ok := patch_from_json(pv)
			if !ok do continue
			bytes := patch_encode(p)
			back, dok := patch_decode(bytes)
			testing.expectf(t, dok && string(patch_encode(back)) == string(bytes), "%s: patch round-trips", name)
			patches += 1
		}
	}
	testing.expect(t, records > 3 && patches > 0, "vectors exercised")
}
