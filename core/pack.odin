package core

// Packs (docs/state-objects.md "Packs"): a stream's records as of a relay
// cursor, in one blob. The plaintext layout (encryption is the Blossom frame
// format, done by the host: harness/src/pack.ts, roostr-engine pack.rs):
//
//   varint(len(header)) || Pack_Header protobuf || payload
//
//   message Pack_Header {
//     string stream = 1;
//     uint64 cursor = 2;
//     uint64 records = 3;               // total record count
//     repeated Pack_Bucket buckets = 4; // exactly 256, bucket b at index b
//   }
//   message Pack_Bucket {
//     uint64 offset = 1;  // in the payload: sum of the earlier lengths
//     uint64 length = 2;  // compressed bytes; 0 for an empty bucket
//     bytes  hash   = 3;  // 32 bytes: the bucket's fingerprint hash
//     uint32 count  = 4;  // records in the bucket
//   }
//
// Bucket b holds the records whose sha256(object_id)[0] == b, sorted by
// object id (bytewise), each as varint(len) || canonical Record bytes, the
// run compressed as one raw DEFLATE stream (deflate.odin); an empty bucket
// is no bytes. roostr-engine's src/pack.rs is the same format, pinned by
// testdata/record_vectors/pack.json.

import "core:bytes"
import "core:compress/zlib"
import "core:slice"

PACK_BUCKETS :: 256

Pack_Bucket :: struct {
	offset: u64,
	length: u64,
	hash:   [32]byte,
	count:  u32,
}

Pack_Header :: struct {
	stream:  string,
	cursor:  u64,
	records: u64,
	buckets: [PACK_BUCKETS]Pack_Bucket,
}

Pack :: struct {
	plaintext: []byte,
	header:    Pack_Header,
	root:      [32]byte,
}

@(private = "file")
write_u64_field :: proc(w: ^Writer, field: u64, v: u64) {
	if v == 0 do return
	write_tag(w, field, 0)
	write_varint(w, v)
}

pack_header_encode :: proc(h: Pack_Header, allocator := context.allocator) -> []byte {
	w := Writer{buf = make([dynamic]byte, allocator)}
	write_string_field(&w, 1, h.stream)
	write_u64_field(&w, 2, h.cursor)
	write_u64_field(&w, 3, h.records)
	bw := Writer{buf = make([dynamic]byte, context.temp_allocator)}
	for b in h.buckets {
		clear(&bw.buf)
		write_u64_field(&bw, 1, b.offset)
		write_u64_field(&bw, 2, b.length)
		hash := b.hash
		write_len_prefixed(&bw, 3, hash[:])
		write_u64_field(&bw, 4, u64(b.count))
		write_len_prefixed(&w, 4, bw.buf[:])
	}
	return w.buf[:]
}

/** sha256 of the 256 bucket hashes: the stream's fingerprint root. */
pack_root :: proc(h: Pack_Header) -> [32]byte {
	all: [PACK_BUCKETS * 32]byte
	for b, i in h.buckets {
		hash := b.hash
		copy(all[i * 32:], hash[:])
	}
	return sha256(all[:])
}

/**
 * The pack plaintext for `records` (one per object; tombstoned objects
 * included). False when two records share an object id.
 */
pack_build :: proc(records: []Record, stream: string, cursor: u64, allocator := context.allocator) -> (Pack, bool) {
	Keyed :: struct {
		id:    string,
		index: int,
	}
	order := make([]Keyed, len(records), context.temp_allocator)
	for r, i in records do order[i] = {r.object_id, i}
	slice.sort_by(order, proc(a, b: Keyed) -> bool {return a.id < b.id})
	for i in 1 ..< len(order) do if order[i].id == order[i - 1].id do return {}, false

	per_bucket: [PACK_BUCKETS][dynamic]int
	for k in order {
		b := record_bucket(k.id)
		if per_bucket[b] == nil do per_bucket[b] = make([dynamic]int, context.temp_allocator)
		append(&per_bucket[b], k.index)
	}

	h := Pack_Header{stream = stream, cursor = cursor, records = u64(len(records))}
	payload := make([dynamic]byte, context.temp_allocator)
	raw := Writer{buf = make([dynamic]byte, context.temp_allocator)}
	hashes := make([dynamic]byte, context.temp_allocator)
	for b in 0 ..< PACK_BUCKETS {
		clear(&raw.buf)
		clear(&hashes)
		for o in per_bucket[b] {
			encoded := record_encode(records[o], context.temp_allocator)
			write_varint(&raw, u64(len(encoded)))
			append(&raw.buf, ..encoded)
			hash := sha256(encoded)
			append(&hashes, ..hash[:])
		}
		entry := Pack_Bucket{offset = u64(len(payload)), hash = sha256(hashes[:]), count = u32(len(per_bucket[b]))}
		if entry.count > 0 {
			compressed := deflate_compress(raw.buf[:], context.temp_allocator)
			entry.length = u64(len(compressed))
			append(&payload, ..compressed)
		}
		h.buckets[b] = entry
	}

	header := pack_header_encode(h, context.temp_allocator)
	out := Writer{buf = make([dynamic]byte, 0, len(header) + len(payload) + 10, allocator)}
	write_varint(&out, u64(len(header)))
	append(&out.buf, ..header)
	append(&out.buf, ..payload[:])
	return Pack{plaintext = out.buf[:], header = h, root = pack_root(h)}, true
}

/**
 * The header at the start of a pack plaintext (a prefix holding the header
 * is enough: a Lite device reads it from the first frame). Returns where the
 * payload starts. False when malformed: not 256 buckets, a hash not 32
 * bytes, buckets not contiguous, or counts not summing to `records`.
 * `stream` points into `data`.
 */
pack_read_header :: proc(data: []byte) -> (h: Pack_Header, payload_start: int, ok: bool) {
	r := Reader{data = data}
	size := read_varint(&r)
	if r.err || size > u64(len(data) - r.pos) do return
	hr := Reader{data = data[r.pos:r.pos + int(size)]}
	payload_start = r.pos + int(size)
	n := 0
	for hr.pos < len(hr.data) && !hr.err {
		tag := read_varint(&hr)
		field, wire := tag >> 3, tag & 7
		switch {
		case field == 1 && wire == 2: h.stream = read_string(&hr)
		case field == 2 && wire == 0: h.cursor = read_varint(&hr)
		case field == 3 && wire == 0: h.records = read_varint(&hr)
		case field == 4 && wire == 2:
			br := Reader{data = read_bytes(&hr)}
			if hr.err || n >= PACK_BUCKETS do return
			b: Pack_Bucket
			hash_len := -1
			for br.pos < len(br.data) && !br.err {
				btag := read_varint(&br)
				switch {
				case btag >> 3 == 1 && btag & 7 == 0: b.offset = read_varint(&br)
				case btag >> 3 == 2 && btag & 7 == 0: b.length = read_varint(&br)
				case btag >> 3 == 3 && btag & 7 == 2:
					hash := read_bytes(&br)
					hash_len = len(hash)
					if hash_len == 32 do copy(b.hash[:], hash)
				case btag >> 3 == 4 && btag & 7 == 0: b.count = u32(read_varint(&br))
				case: skip_field(&br, btag & 7)
				}
			}
			if br.err || hash_len != 32 do return
			h.buckets[n] = b
			n += 1
		case: skip_field(&hr, wire)
		}
	}
	if hr.err || n != PACK_BUCKETS do return
	next, total: u64
	for b in h.buckets {
		if b.offset != next || (b.length == 0) != (b.count == 0) do return
		next += b.length
		total += u64(b.count)
	}
	if total != h.records do return
	ok = true
	return
}

/** Bucket `b`'s compressed bytes inside a whole plaintext (false when the plaintext is too short). */
pack_bucket_bytes :: proc(plaintext: []byte, h: Pack_Header, payload_start: int, b: int) -> ([]byte, bool) {
	entry := h.buckets[b]
	start := u64(payload_start) + entry.offset
	if start + entry.length > u64(len(plaintext)) do return nil, false
	return plaintext[start:start + entry.length], true
}

/**
 * The records of bucket `b` from its compressed bytes, checked against the
 * header: count, ids in strictly increasing order and in bucket `b`, and
 * the bucket hash (over each record's canonical re-encoding, so the result
 * matches records_fingerprint). Records point into a buffer from `allocator`.
 */
pack_read_bucket :: proc(data: []byte, h: Pack_Header, b: int, allocator := context.allocator) -> ([]Record, bool) {
	entry := h.buckets[b]
	if u64(len(data)) != entry.length do return nil, false
	if entry.count == 0 do return nil, true
	buf: bytes.Buffer
	defer bytes.buffer_destroy(&buf)
	if zlib.inflate(data, &buf, raw = true) != nil do return nil, false
	raw := slice.clone(bytes.buffer_to_bytes(&buf), allocator)
	out := make([dynamic]Record, 0, int(entry.count), allocator)
	hashes := make([dynamic]byte, context.temp_allocator)
	r := Reader{data = raw}
	for r.pos < len(raw) {
		encoded := read_bytes(&r)
		if r.err || len(out) >= int(entry.count) do return nil, false
		rec, ok := record_decode(encoded, allocator)
		if !ok || int(record_bucket(rec.object_id)) != b do return nil, false
		if len(out) > 0 && !(out[len(out) - 1].object_id < rec.object_id) do return nil, false
		hash := record_hash(rec)
		append(&hashes, ..hash[:])
		append(&out, rec)
	}
	if len(out) != int(entry.count) || sha256(hashes[:]) != entry.hash do return nil, false
	return out[:], true
}
