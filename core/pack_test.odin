#+build !js
package core

import "core:bytes"
import "core:compress/zlib"
import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"
import "core:os"
import "core:strings"
import "core:testing"

// testdata/record_vectors/pack.json, shared with roostr-engine's tests and
// the harness (src/pack.test.ts). With RECORD_VECTORS_WRITE=1 this test
// fills `expected` (pack plaintext and deflate outputs) instead of checking
// it; the harness fills `encrypted` and the frame ranges.

@(private = "file")
hexs :: proc(b: []byte) -> string {
	return string(hex.encode(b, context.temp_allocator))
}

@(private = "file")
writing :: proc() -> bool {
	return os.get_env("RECORD_VECTORS_WRITE", context.temp_allocator) == "1"
}

@(private = "file")
check :: proc(t: ^testing.T, item: json.Value, actual: json.Value, label: string) {
	if writing() {
		if obj, ok := item.(json.Object); ok do obj["expected"] = actual
		return
	}
	expected, _ := json_field(item, "expected")
	testing.expectf(t, string(marshal(actual)) == string(marshal(expected)), "%s\n got: %s\nwant: %s", label, string(marshal(actual)), string(marshal(expected)))
}

/** A deflate case's input: {text} | {repeat, times} | {lcg, length, alphabet}. */
@(private = "file")
deflate_input :: proc(spec: json.Value) -> []byte {
	if text, ok := json_field(spec, "text"); ok do return transmute([]byte)string(text.(json.String))
	out := make([dynamic]byte)
	if _, ok := json_field(spec, "repeat"); ok {
		unit := json_str(spec, "repeat")
		times, _ := json_int(spec, "times")
		for _ in 0 ..< times do append(&out, unit)
		return out[:]
	}
	seed, _ := json_int(spec, "lcg")
	length, _ := json_int(spec, "length")
	alphabet, _ := json_int(spec, "alphabet")
	x := u64(seed)
	for _ in 0 ..< length {
		x = x * 6364136223846793005 + 1442695040888963407
		append(&out, byte((x >> 33) % u64(alphabet)))
	}
	return out[:]
}

@(private = "file")
inflate_raw :: proc(data: []byte) -> ([]byte, bool) {
	buf: bytes.Buffer
	if zlib.inflate(data, &buf, raw = true) != nil do return nil, false
	return bytes.buffer_to_bytes(&buf), true
}

@(private = "file")
pack_vector_records :: proc(root: json.Value) -> [dynamic]Record {
	records := make([dynamic]Record)
	for rv in json_array(root, "records") {
		r, _ := record_from_json(rv)
		append(&records, r)
	}
	return records
}

@(test)
pack_vectors_conformance :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	root, err := json.parse(#load("testdata/record_vectors/pack.json"), parse_integers = true)
	testing.expect(t, err == nil, "pack.json parses")
	if err != nil do return

	for item in json_array(root, "deflate") {
		name := json_str(item, "name")
		input, _ := json_field(item, "input")
		data := deflate_input(input)
		out := deflate_compress(data)
		back, ok := inflate_raw(out)
		testing.expectf(t, ok && string(back) == string(data), "%s: inflates back", name)
		o := jobj()
		if len(out) <= 2048 do o["output"] = json.String(hexs(out))
		hash := sha256(out)
		o["outputSha256"] = json.String(hexs(hash[:]))
		o["outputLength"] = json.Integer(i64(len(out)))
		check(t, item, json.Object(o), name)
	}

	records := pack_vector_records(root)
	cursor, _ := json_int(root, "cursor")
	pack, ok := pack_build(records[:], json_str(root, "stream"), u64(cursor))
	testing.expect(t, ok, "pack builds")
	h, payload_start, hok := pack_read_header(pack.plaintext)
	testing.expect(t, hok, "header reads back")
	testing.expect(t, string(pack_header_encode(h)) == string(pack_header_encode(pack.header)), "header round trips")
	testing.expect(t, pack.root == records_fingerprint(records[:]).root, "root is the fingerprint root")

	o := jobj()
	o["plaintext"] = json.String(hexs(pack.plaintext))
	o["payloadStart"] = json.Integer(i64(payload_start))
	header := jobj()
	header["stream"] = json.String(h.stream)
	header["cursor"] = json.Integer(i64(h.cursor))
	header["records"] = json.Integer(i64(h.records))
	buckets := jobj()
	contents := jobj()
	empty := sha256(nil)
	for &b, i in h.buckets {
		if b.count == 0 {
			testing.expectf(t, b.hash == empty && b.length == 0, "bucket %d: empty", i)
			continue
		}
		bo := jobj()
		bo["offset"] = json.Integer(i64(b.offset))
		bo["length"] = json.Integer(i64(b.length))
		bo["hash"] = json.String(hexs(b.hash[:]))
		bo["count"] = json.Integer(i64(b.count))
		buckets[fmt.tprintf("%d", i)] = json.Object(bo)

		data, dok := pack_bucket_bytes(pack.plaintext, h, payload_start, i)
		testing.expect(t, dok)
		raw, rok := inflate_raw(data)
		testing.expect(t, rok)
		got, gok := pack_read_bucket(data, h, i)
		testing.expectf(t, gok, "bucket %d reads", i)
		ids := make([dynamic]json.Value)
		for r in got {
			append(&ids, json.String(r.object_id))
			for want in records do if want.object_id == r.object_id {
				testing.expectf(t, string(record_encode(r)) == string(record_encode(want)), "%s round trips", r.object_id)
			}
		}
		co := jobj()
		co["raw"] = json.String(hexs(raw))
		co["ids"] = json.Array(ids)
		contents[fmt.tprintf("%d", i)] = json.Object(co)
	}
	header["buckets"] = json.Object(buckets)
	o["header"] = json.Object(header)
	o["buckets"] = json.Object(contents)
	o["emptyBucketHash"] = json.String(hexs(empty[:]))
	o["root"] = json.String(hexs(pack.root[:]))
	check(t, root, json.Object(o), "pack")

	if writing() {
		out, merr := json.marshal(root, json.Marshal_Options{pretty = true, use_spaces = true, spaces = 1, sort_maps_by_key = true})
		testing.expect(t, merr == nil)
		body := strings.concatenate({string(out), "\n"})
		testing.expect(t, os.write_entire_file(#directory + "/testdata/record_vectors/pack.json", transmute([]byte)body) == nil, "write pack.json")
	}
}

@(test)
pack_rejects_bad_input :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	a := Record{object_id = "same", created_at = 1}
	b := Record{object_id = "same", created_at = 2}
	_, ok := pack_build({a, b}, "s", 1)
	testing.expect(t, !ok, "two records for one object are refused")

	root, _ := json.parse(#load("testdata/record_vectors/pack.json"), parse_integers = true)
	records := pack_vector_records(root)
	pack, _ := pack_build(records[:], "s", 7)
	h, start, hok := pack_read_header(pack.plaintext)
	testing.expect(t, hok)
	_, _, cut_ok := pack_read_header(pack.plaintext[:start - 1])
	testing.expect(t, !cut_ok, "a truncated header is refused")

	for &bucket, i in h.buckets {
		if bucket.count == 0 do continue
		data, _ := pack_bucket_bytes(pack.plaintext, h, start, i)
		tampered := make([]byte, len(data))
		copy(tampered, data)
		tampered[len(tampered) / 2] ~= 0x20
		_, tok := pack_read_bucket(tampered, h, i)
		testing.expectf(t, !tok, "bucket %d: tampered bytes are refused", i)
		wrong := h
		wrong.buckets[i].hash[0] ~= 1
		_, wok := pack_read_bucket(data, wrong, i)
		testing.expectf(t, !wok, "bucket %d: a hash mismatch is refused", i)
		_, short := pack_bucket_bytes(pack.plaintext[:start + int(bucket.offset + bucket.length) - 1], h, start, i)
		testing.expect(t, !short, "a short plaintext is refused")
		break
	}
}

@(test)
pack_round_trips_many_records :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	records := make([dynamic]Record)
	for i in 0 ..< 1500 {
		r := Record{object_id = fmt.tprintf("object-%04d", i), created_at = i64(1_700_000_000_000 + i)}
		r.fields = make([dynamic]Record_Entry)
		append(&r.fields, Record_Entry{key = "name", stamp = stamp_from_ms(i64(1_700_000_000_000 + i), u32(i % 3)), kind = .Value, value = Value{kind = .String, str = fmt.tprintf("Note number %d, about %s", i, i % 2 == 0 ? "packs" : "records")}})
		append(&records, r)
	}
	pack, ok := pack_build(records[:], "stream", 99)
	testing.expect(t, ok)
	h, start, hok := pack_read_header(pack.plaintext)
	testing.expect(t, hok && h.records == 1500)
	total := 0
	for i in 0 ..< PACK_BUCKETS {
		data, _ := pack_bucket_bytes(pack.plaintext, h, start, i)
		got, gok := pack_read_bucket(data, h, i)
		testing.expectf(t, gok, "bucket %d", i)
		total += len(got)
	}
	testing.expect_value(t, total, 1500)
	testing.expect(t, pack.root == records_fingerprint(records[:]).root)
}
