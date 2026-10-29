package core

// Readers for the canonical Record and Patch protobufs (record_encode,
// patch_encode): a store that keeps records on disk (src/records.odin) reads
// them back. Strings and bytes point into `data`, so it must outlive the
// result. Unknown fields (and known numbers with an unexpected wire type)
// are skipped; a truncated message fails the decode. Odin only for now: the
// Rust engine has no reader yet (it does not store records).

@(private = "file")
decode_value_map :: proc(data: []byte, allocator := context.allocator) -> ([dynamic]Value_Entry, bool) {
	out := make([dynamic]Value_Entry, allocator)
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		if tag >> 3 != 1 || tag & 7 != 2 {
			skip_field(&r, tag & 7)
			continue
		}
		er := Reader{data = read_bytes(&r)}
		e: Value_Entry
		for er.pos < len(er.data) && !er.err {
			etag := read_varint(&er)
			switch {
			case etag >> 3 == 1 && etag & 7 == 2: e.key = read_string(&er)
			case etag >> 3 == 2 && etag & 7 == 2: e.value = decode_value(read_bytes(&er), allocator)
			case: skip_field(&er, etag & 7)
			}
		}
		if er.err do return out, false
		append(&out, e)
	}
	return out, !r.err
}

@(private = "file")
decode_entry_body :: proc(data: []byte, allocator := context.allocator) -> (Entry_Body, bool) {
	b: Entry_Body
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		switch {
		case field == 1 && wire == 2: b.parent = read_string(&r)
		case field == 2 && wire == 2: b.position = read_string(&r)
		case field == 3 && wire == 2: b.content = decode_block_content(read_bytes(&r), allocator)
		case field == 4 && wire == 2:
			fields, ok := decode_value_map(read_bytes(&r), allocator)
			if !ok do return b, false
			b.fields = fields
		case field == 5 && wire == 0: b.align = as_i64(read_varint(&r))
		case field == 6 && wire == 2: b.background_color = read_string(&r)
		case: skip_field(&r, wire)
		}
	}
	if b.fields == nil do b.fields = make([dynamic]Value_Entry, allocator)
	return b, !r.err
}

/** One Entry message (no outer tag): the inverse of encode_entry. */
decode_record_entry :: proc(data: []byte, allocator := context.allocator) -> (Record_Entry, bool) {
	context.allocator = allocator
	e: Record_Entry
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		switch {
		case field == 1 && wire == 2:
			e.key = read_string(&r)
		case field == 2 && wire == 2:
			sr := Reader{data = read_bytes(&r)}
			for sr.pos < len(sr.data) && !sr.err {
				stag := read_varint(&sr)
				switch {
				case stag >> 3 == 1 && stag & 7 == 0: e.stamp.time = read_varint(&sr)
				case stag >> 3 == 2 && stag & 7 == 0: e.stamp.device = u32(read_varint(&sr))
				case: skip_field(&sr, stag & 7)
				}
			}
			if sr.err do return e, false
		case field == 3 && wire == 0:
			e.gone = read_varint(&r) != 0
		case field == 4 && wire == 2:
			e.kind = .Value
			e.value = decode_value(read_bytes(&r), allocator)
		case (field == 5 || field == 6) && wire == 2:
			e.kind = field == 5 ? .Block : .Message
			body, ok := decode_entry_body(read_bytes(&r), allocator)
			if !ok do return e, false
			e.body = body
		case:
			skip_field(&r, wire)
		}
	}
	return e, !r.err
}

@(private = "file")
read_entry_field :: proc(r: ^Reader, allocator := context.allocator) -> (Record_Entry, bool) {
	data := read_bytes(r)
	if r.err do return {}, false
	return decode_record_entry(data, allocator)
}

/** The inverse of record_encode. False on malformed bytes. */
record_decode :: proc(data: []byte, allocator := context.allocator) -> (Record, bool) {
	context.allocator = allocator
	rec: Record
	rec.fields = make([dynamic]Record_Entry, allocator)
	rec.blocks = make([dynamic]Record_Entry, allocator)
	rec.messages = make([dynamic]Record_Entry, allocator)
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		if field >= 2 && field <= 6 && wire == 2 {
			e, ok := read_entry_field(&r, allocator)
			if !ok do return rec, false
			switch field {
			case 2: rec.type = e
			case 3: rec.deleted = e
			case 4: append(&rec.fields, e)
			case 5: append(&rec.blocks, e)
			case 6: append(&rec.messages, e)
			}
			continue
		}
		switch {
		case field == 1 && wire == 2: rec.object_id = read_string(&r)
		case field == 7 && wire == 0: rec.created_at = as_i64(read_varint(&r))
		case: skip_field(&r, wire)
		}
	}
	return rec, !r.err
}

/** The inverse of patch_encode. False on malformed bytes. */
patch_decode :: proc(data: []byte, allocator := context.allocator) -> (Patch, bool) {
	context.allocator = allocator
	p: Patch
	p.entries = make([dynamic]Record_Entry, allocator)
	r := Reader{data = data}
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		field, wire := tag >> 3, tag & 7
		switch {
		case field == 1 && wire == 2:
			p.object_id = read_string(&r)
		case field == 2 && wire == 2:
			e, ok := read_entry_field(&r, allocator)
			if !ok do return p, false
			append(&p.entries, e)
		case:
			skip_field(&r, wire)
		}
	}
	return p, !r.err
}
