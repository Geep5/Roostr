package glon

// Protobuf wire codec for glon.proto — hand-rolled, schema-locked.
//
// Decode accepts anything the TS implementation (protobufjs) wrote.
// Encode follows proto3 emission rules (defaults omitted, fields in
// field-number order) so content addresses stay stable:
//   change id = sha256(encode(change with id absent))

import "core:crypto/sha2"

// ── Model ────────────────────────────────────────────────────────────

Value_Kind :: enum u8 {
	None,
	String,
	Int,
	Float,
	Bool,
	Bytes,
	String_List,
	Map,
	List,
	Link,
}

Value_Entry :: struct {
	key:   string,
	value: Value,
}

Value :: struct {
	kind:          Value_Kind,
	str:           string,
	i:             i64,
	f:             f64,
	b:             bool,
	bytes:         []byte,
	strings:       [dynamic]string,
	entries:       [dynamic]Value_Entry, // Map
	items:         [dynamic]Value,       // List
	link_target:   string,
	link_relation: string,
}

Mark :: struct {
	from:  i64,
	to:    i64,
	type:  i64,
	param: string,
}

Text_Content :: struct {
	text:    string,
	style:   i64,
	marks:   [dynamic]Mark,
	checked: bool,
	color:   string,
}

Str_Pair :: struct {
	key:   string,
	value: string,
}

Custom_Content :: struct {
	content_type: string,
	data:         []byte,
	meta:         [dynamic]Str_Pair,
}

Content_Kind :: enum u8 {
	None,
	Text,
	Custom,
	Layout,
}

Block_Content :: struct {
	kind:         Content_Kind,
	text:         Text_Content,
	custom:       Custom_Content,
	layout_style: i64,
}

Block :: struct {
	id:               string,
	children_ids:     [dynamic]string,
	content:          Block_Content,
	fields:           [dynamic]Value_Entry,
	align:            i64,
	background_color: string,
}

Op_Kind :: enum u8 {
	None,
	Object_Create,
	Object_Delete,
	Field_Set,
	Field_Delete,
	Block_Add,
	Block_Remove,
	Block_Update,
	Block_Move,
	Block_Set_Align,
	Block_Set_Background,
}

Operation :: struct {
	kind:      Op_Kind,
	type_key:  string, // object_create
	key:       string, // field ops
	value:     Value,  // field_set
	block:     Block,  // block_add
	block_id:  string,
	parent_id: string,
	after_id:  string,
	target_id: string,
	position:  i64,
	content:   Block_Content, // block_update
	align:     i64,           // block_set_align
	color:     string,        // block_set_background
}

Snapshot :: struct {
	id:         string,
	type_key:   string,
	fields:     [dynamic]Value_Entry,
	content:    []byte, // deprecated primary content
	blocks:     [dynamic]Block,
	deleted:    bool,
	created_at: i64,
	updated_at: i64,
}

Change :: struct {
	id:           []byte,
	object_id:    string,
	parent_ids:   [dynamic][]byte,
	ops:          [dynamic]Operation,
	timestamp:    i64,
	author:       string,
	has_snapshot: bool,
	snapshot:     Snapshot,
}

// ── Wire reader ──────────────────────────────────────────────────────

Reader :: struct {
	data: []byte,
	pos:  int,
	err:  bool,
}

read_varint :: proc(r: ^Reader) -> u64 {
	result: u64 = 0
	shift: uint = 0
	for r.pos < len(r.data) {
		b := r.data[r.pos]
		r.pos += 1
		result |= u64(b & 0x7f) << shift
		if b < 0x80 do return result
		shift += 7
		if shift >= 64 {
			r.err = true
			return 0
		}
	}
	r.err = true
	return 0
}

read_bytes :: proc(r: ^Reader) -> []byte {
	n := int(read_varint(r))
	if r.err || r.pos + n > len(r.data) {
		r.err = true
		return nil
	}
	out := r.data[r.pos:r.pos + n]
	r.pos += n
	return out
}

read_string :: proc(r: ^Reader) -> string {
	return string(read_bytes(r))
}

skip_field :: proc(r: ^Reader, wire: u64) {
	switch wire {
	case 0:
		_ = read_varint(r)
	case 1:
		r.pos += 8
	case 2:
		_ = read_bytes(r)
	case 5:
		r.pos += 4
	case:
		r.err = true
	}
	if r.pos > len(r.data) do r.err = true
}

// zigzag not used (no sint fields); int64 encoded as plain varint.
as_i64 :: proc(v: u64) -> i64 {
	return i64(v)
}

// ── Message decoders ─────────────────────────────────────────────────

decode_value :: proc(data: []byte, allocator := context.allocator) -> Value {
	r := Reader{data = data}
	v: Value
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		field := tag >> 3
		wire := tag & 7
		switch field {
		case 1:
			v.kind = .String
			v.str = read_string(&r)
		case 2:
			v.kind = .Int
			v.i = as_i64(read_varint(&r))
		case 3:
			v.kind = .Float
			if r.pos + 8 <= len(r.data) {
				v.f = (transmute(^f64)&r.data[r.pos])^
				r.pos += 8
			} else {
				r.err = true
			}
		case 4:
			v.kind = .Bool
			v.b = read_varint(&r) != 0
		case 5:
			v.kind = .Bytes
			v.bytes = read_bytes(&r)
		case 6:
			v.kind = .String_List
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				if stag >> 3 == 1 && stag & 7 == 2 {
					append(&v.strings, read_string(&sub))
				} else {
					skip_field(&sub, stag & 7)
				}
			}
		case 7:
			v.kind = .Map
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				if stag >> 3 == 1 && stag & 7 == 2 {
					entry_data := read_bytes(&sub)
					er := Reader{data = entry_data}
					e: Value_Entry
					for er.pos < len(er.data) && !er.err {
						etag := read_varint(&er)
						switch etag >> 3 {
						case 1:
							e.key = read_string(&er)
						case 2:
							e.value = decode_value(read_bytes(&er), allocator)
						case:
							skip_field(&er, etag & 7)
						}
					}
					append(&v.entries, e)
				} else {
					skip_field(&sub, stag & 7)
				}
			}
		case 8:
			v.kind = .List
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				if stag >> 3 == 1 && stag & 7 == 2 {
					append(&v.items, decode_value(read_bytes(&sub), allocator))
				} else {
					skip_field(&sub, stag & 7)
				}
			}
		case 9:
			v.kind = .Link
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				switch stag >> 3 {
				case 1:
					v.link_target = read_string(&sub)
				case 2:
					v.link_relation = read_string(&sub)
				case:
					skip_field(&sub, stag & 7)
				}
			}
		case:
			skip_field(&r, wire)
		}
	}
	return v
}

decode_mark :: proc(data: []byte) -> Mark {
	r := Reader{data = data}
	m: Mark
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		switch tag >> 3 {
		case 1:
			m.from = as_i64(read_varint(&r))
		case 2:
			m.to = as_i64(read_varint(&r))
		case 3:
			m.type = as_i64(read_varint(&r))
		case 4:
			m.param = read_string(&r)
		case:
			skip_field(&r, tag & 7)
		}
	}
	return m
}

decode_block_content :: proc(data: []byte, allocator := context.allocator) -> Block_Content {
	r := Reader{data = data}
	c: Block_Content
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		switch tag >> 3 {
		case 1:
			c.kind = .Text
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				switch stag >> 3 {
				case 1:
					c.text.text = read_string(&sub)
				case 2:
					c.text.style = as_i64(read_varint(&sub))
				case 3:
					append(&c.text.marks, decode_mark(read_bytes(&sub)))
				case 4:
					c.text.checked = read_varint(&sub) != 0
				case 5:
					c.text.color = read_string(&sub)
				case:
					skip_field(&sub, stag & 7)
				}
			}
		case 2:
			c.kind = .Custom
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				switch stag >> 3 {
				case 1:
					c.custom.content_type = read_string(&sub)
				case 2:
					c.custom.data = read_bytes(&sub)
				case 3:
					entry := Reader{data = read_bytes(&sub)}
					p: Str_Pair
					for entry.pos < len(entry.data) && !entry.err {
						etag := read_varint(&entry)
						switch etag >> 3 {
						case 1:
							p.key = read_string(&entry)
						case 2:
							p.value = read_string(&entry)
						case:
							skip_field(&entry, etag & 7)
						}
					}
					append(&c.custom.meta, p)
				case:
					skip_field(&sub, stag & 7)
				}
			}
		case 3:
			c.kind = .Layout
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				if stag >> 3 == 1 {
					c.layout_style = as_i64(read_varint(&sub))
				} else {
					skip_field(&sub, stag & 7)
				}
			}
		case:
			skip_field(&r, tag & 7)
		}
	}
	return c
}

decode_block :: proc(data: []byte, allocator := context.allocator) -> Block {
	r := Reader{data = data}
	b: Block
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		switch tag >> 3 {
		case 1:
			b.id = read_string(&r)
		case 2:
			append(&b.children_ids, read_string(&r))
		case 3:
			b.content = decode_block_content(read_bytes(&r), allocator)
		case 4:
			// ValueMap message: repeated map entries at field 1.
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				if stag >> 3 == 1 && stag & 7 == 2 {
					entry := Reader{data = read_bytes(&sub)}
					e: Value_Entry
					for entry.pos < len(entry.data) && !entry.err {
						etag := read_varint(&entry)
						switch etag >> 3 {
						case 1:
							e.key = read_string(&entry)
						case 2:
							e.value = decode_value(read_bytes(&entry), allocator)
						case:
							skip_field(&entry, etag & 7)
						}
					}
					append(&b.fields, e)
				} else {
					skip_field(&sub, stag & 7)
				}
			}
		case 5:
			b.align = as_i64(read_varint(&r))
		case 6:
			b.background_color = read_string(&r)
		case:
			skip_field(&r, tag & 7)
		}
	}
	return b
}

decode_operation :: proc(data: []byte, allocator := context.allocator) -> Operation {
	r := Reader{data = data}
	op: Operation
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		field := tag >> 3
		switch field {
		case 1:
			op.kind = .Object_Create
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				if stag >> 3 == 1 {
					op.type_key = read_string(&sub)
				} else {
					skip_field(&sub, stag & 7)
				}
			}
		case 2:
			op.kind = .Object_Delete
			_ = read_bytes(&r)
		case 3:
			op.kind = .Field_Set
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				switch stag >> 3 {
				case 1:
					op.key = read_string(&sub)
				case 2:
					op.value = decode_value(read_bytes(&sub), allocator)
				case:
					skip_field(&sub, stag & 7)
				}
			}
		case 4:
			op.kind = .Field_Delete
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				if stag >> 3 == 1 {
					op.key = read_string(&sub)
				} else {
					skip_field(&sub, stag & 7)
				}
			}
		case 6:
			op.kind = .Block_Add
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				switch stag >> 3 {
				case 1:
					op.parent_id = read_string(&sub)
				case 2:
					op.after_id = read_string(&sub)
				case 3:
					op.block = decode_block(read_bytes(&sub), allocator)
				case 4:
					op.target_id = read_string(&sub)
				case 5:
					op.position = as_i64(read_varint(&sub))
				case:
					skip_field(&sub, stag & 7)
				}
			}
		case 7:
			op.kind = .Block_Remove
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				if stag >> 3 == 1 {
					op.block_id = read_string(&sub)
				} else {
					skip_field(&sub, stag & 7)
				}
			}
		case 8:
			op.kind = .Block_Update
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				switch stag >> 3 {
				case 1:
					op.block_id = read_string(&sub)
				case 2:
					op.content = decode_block_content(read_bytes(&sub), allocator)
				case:
					skip_field(&sub, stag & 7)
				}
			}
		case 9:
			op.kind = .Block_Move
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				switch stag >> 3 {
				case 1:
					op.block_id = read_string(&sub)
				case 2:
					op.parent_id = read_string(&sub)
				case 3:
					op.after_id = read_string(&sub)
				case 4:
					op.target_id = read_string(&sub)
				case 5:
					op.position = as_i64(read_varint(&sub))
				case:
					skip_field(&sub, stag & 7)
				}
			}
		case 10:
			op.kind = .Block_Set_Align
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				switch stag >> 3 {
				case 1:
					op.block_id = read_string(&sub)
				case 2:
					op.align = as_i64(read_varint(&sub))
				case:
					skip_field(&sub, stag & 7)
				}
			}
		case 11:
			op.kind = .Block_Set_Background
			sub := Reader{data = read_bytes(&r)}
			for sub.pos < len(sub.data) && !sub.err {
				stag := read_varint(&sub)
				switch stag >> 3 {
				case 1:
					op.block_id = read_string(&sub)
				case 2:
					op.color = read_string(&sub)
				case:
					skip_field(&sub, stag & 7)
				}
			}
		case:
			skip_field(&r, tag & 7)
		}
	}
	return op
}

decode_snapshot :: proc(data: []byte, allocator := context.allocator) -> Snapshot {
	r := Reader{data = data}
	s: Snapshot
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		switch tag >> 3 {
		case 1:
			s.id = read_string(&r)
		case 2:
			s.type_key = read_string(&r)
		case 3:
			entry := Reader{data = read_bytes(&r)}
			e: Value_Entry
			for entry.pos < len(entry.data) && !entry.err {
				etag := read_varint(&entry)
				switch etag >> 3 {
				case 1:
					e.key = read_string(&entry)
				case 2:
					e.value = decode_value(read_bytes(&entry), allocator)
				case:
					skip_field(&entry, etag & 7)
				}
			}
			append(&s.fields, e)
		case 4:
			s.content = read_bytes(&r)
		case 5:
			append(&s.blocks, decode_block(read_bytes(&r), allocator))
		case 6:
			s.deleted = read_varint(&r) != 0
		case 7:
			s.created_at = as_i64(read_varint(&r))
		case 8:
			s.updated_at = as_i64(read_varint(&r))
		case:
			skip_field(&r, tag & 7)
		}
	}
	return s
}

decode_change :: proc(data: []byte, allocator := context.allocator) -> (Change, bool) {
	r := Reader{data = data}
	c: Change
	for r.pos < len(r.data) && !r.err {
		tag := read_varint(&r)
		switch tag >> 3 {
		case 1:
			c.id = read_bytes(&r)
		case 2:
			c.object_id = read_string(&r)
		case 3:
			append(&c.parent_ids, read_bytes(&r))
		case 4:
			append(&c.ops, decode_operation(read_bytes(&r), allocator))
		case 5:
			c.timestamp = as_i64(read_varint(&r))
		case 6:
			c.author = read_string(&r)
		case 7:
			c.has_snapshot = true
			c.snapshot = decode_snapshot(read_bytes(&r), allocator)
		case:
			skip_field(&r, tag & 7)
		}
	}
	return c, !r.err
}

// ── Wire writer ──────────────────────────────────────────────────────

Writer :: struct {
	buf: [dynamic]byte,
}

write_varint :: proc(w: ^Writer, v: u64) {
	x := v
	for x >= 0x80 {
		append(&w.buf, byte(x & 0x7f) | 0x80)
		x >>= 7
	}
	append(&w.buf, byte(x))
}

write_tag :: proc(w: ^Writer, field: u64, wire: u64) {
	write_varint(w, field << 3 | wire)
}

write_len_prefixed :: proc(w: ^Writer, field: u64, data: []byte) {
	write_tag(w, field, 2)
	write_varint(w, u64(len(data)))
	append(&w.buf, ..data)
}

write_string_field :: proc(w: ^Writer, field: u64, s: string) {
	if len(s) == 0 do return // proto3: defaults omitted
	write_len_prefixed(w, field, transmute([]byte)s)
}

write_i64_field :: proc(w: ^Writer, field: u64, v: i64) {
	if v == 0 do return
	write_tag(w, field, 0)
	write_varint(w, u64(v))
}

write_bool_field :: proc(w: ^Writer, field: u64, v: bool) {
	if !v do return
	write_tag(w, field, 0)
	write_varint(w, 1)
}

encode_value :: proc(v: Value, w: ^Writer) {
	switch v.kind {
	case .None:
	case .String:
		// oneof member: always emitted, even when "".
		write_len_prefixed(w, 1, transmute([]byte)v.str)
	case .Int:
		write_tag(w, 2, 0)
		write_varint(w, u64(v.i))
	case .Float:
		write_tag(w, 3, 1)
		f := v.f
		bits := (transmute(^[8]byte)&f)^
		append(&w.buf, ..bits[:])
	case .Bool:
		write_tag(w, 4, 0)
		write_varint(w, v.b ? 1 : 0)
	case .Bytes:
		write_len_prefixed(w, 5, v.bytes)
	case .String_List:
		sub: Writer
		for s in v.strings do write_len_prefixed(&sub, 1, transmute([]byte)s)
		write_len_prefixed(w, 6, sub.buf[:])
		delete(sub.buf)
	case .Map:
		sub: Writer
		for e in v.entries {
			entry: Writer
			write_string_field(&entry, 1, e.key)
			vw: Writer
			encode_value(e.value, &vw)
			write_len_prefixed(&entry, 2, vw.buf[:])
			delete(vw.buf)
			write_len_prefixed(&sub, 1, entry.buf[:])
			delete(entry.buf)
		}
		write_len_prefixed(w, 7, sub.buf[:])
		delete(sub.buf)
	case .List:
		sub: Writer
		for item in v.items {
			iw: Writer
			encode_value(item, &iw)
			write_len_prefixed(&sub, 1, iw.buf[:])
			delete(iw.buf)
		}
		write_len_prefixed(w, 8, sub.buf[:])
		delete(sub.buf)
	case .Link:
		sub: Writer
		write_string_field(&sub, 1, v.link_target)
		write_string_field(&sub, 2, v.link_relation)
		write_len_prefixed(w, 9, sub.buf[:])
		delete(sub.buf)
	}
}

encode_block_content :: proc(c: Block_Content, w: ^Writer) {
	switch c.kind {
	case .None:
	case .Text:
		sub: Writer
		write_string_field(&sub, 1, c.text.text)
		write_i64_field(&sub, 2, c.text.style)
		for m in c.text.marks {
			mw: Writer
			write_i64_field(&mw, 1, m.from)
			write_i64_field(&mw, 2, m.to)
			write_i64_field(&mw, 3, m.type)
			write_string_field(&mw, 4, m.param)
			write_len_prefixed(&sub, 3, mw.buf[:])
			delete(mw.buf)
		}
		write_bool_field(&sub, 4, c.text.checked)
		write_string_field(&sub, 5, c.text.color)
		write_len_prefixed(w, 1, sub.buf[:])
		delete(sub.buf)
	case .Custom:
		sub: Writer
		write_string_field(&sub, 1, c.custom.content_type)
		if len(c.custom.data) > 0 do write_len_prefixed(&sub, 2, c.custom.data)
		for p in c.custom.meta {
			pw: Writer
			write_string_field(&pw, 1, p.key)
			write_string_field(&pw, 2, p.value)
			write_len_prefixed(&sub, 3, pw.buf[:])
			delete(pw.buf)
		}
		write_len_prefixed(w, 2, sub.buf[:])
		delete(sub.buf)
	case .Layout:
		sub: Writer
		write_i64_field(&sub, 1, c.layout_style)
		write_len_prefixed(w, 3, sub.buf[:])
		delete(sub.buf)
	}
}

encode_block :: proc(b: Block, w: ^Writer) {
	write_string_field(w, 1, b.id)
	for c in b.children_ids do write_len_prefixed(w, 2, transmute([]byte)c)
	if b.content.kind != .None {
		cw: Writer
		encode_block_content(b.content, &cw)
		write_len_prefixed(w, 3, cw.buf[:])
		delete(cw.buf)
	}
	if len(b.fields) > 0 {
		fw: Writer
		for e in b.fields {
			entry: Writer
			write_string_field(&entry, 1, e.key)
			vw: Writer
			encode_value(e.value, &vw)
			write_len_prefixed(&entry, 2, vw.buf[:])
			delete(vw.buf)
			write_len_prefixed(&fw, 1, entry.buf[:])
			delete(entry.buf)
		}
		write_len_prefixed(w, 4, fw.buf[:])
		delete(fw.buf)
	}
	write_i64_field(w, 5, b.align)
	write_string_field(w, 6, b.background_color)
}

encode_operation :: proc(op: Operation, w: ^Writer) {
	sub: Writer
	field: u64
	switch op.kind {
	case .None:
		return
	case .Object_Create:
		field = 1
		write_string_field(&sub, 1, op.type_key)
	case .Object_Delete:
		field = 2
	case .Field_Set:
		field = 3
		write_string_field(&sub, 1, op.key)
		vw: Writer
		encode_value(op.value, &vw)
		write_len_prefixed(&sub, 2, vw.buf[:])
		delete(vw.buf)
	case .Field_Delete:
		field = 4
		write_string_field(&sub, 1, op.key)
	case .Block_Add:
		field = 6
		write_string_field(&sub, 1, op.parent_id)
		write_string_field(&sub, 2, op.after_id)
		bw: Writer
		encode_block(op.block, &bw)
		write_len_prefixed(&sub, 3, bw.buf[:])
		delete(bw.buf)
		write_string_field(&sub, 4, op.target_id)
		write_i64_field(&sub, 5, op.position)
	case .Block_Remove:
		field = 7
		write_string_field(&sub, 1, op.block_id)
	case .Block_Update:
		field = 8
		write_string_field(&sub, 1, op.block_id)
		cw: Writer
		encode_block_content(op.content, &cw)
		write_len_prefixed(&sub, 2, cw.buf[:])
		delete(cw.buf)
	case .Block_Move:
		field = 9
		write_string_field(&sub, 1, op.block_id)
		write_string_field(&sub, 2, op.parent_id)
		write_string_field(&sub, 3, op.after_id)
		write_string_field(&sub, 4, op.target_id)
		write_i64_field(&sub, 5, op.position)
	case .Block_Set_Align:
		field = 10
		write_string_field(&sub, 1, op.block_id)
		write_i64_field(&sub, 2, op.align)
	case .Block_Set_Background:
		field = 11
		write_string_field(&sub, 1, op.block_id)
		write_string_field(&sub, 2, op.color)
	}
	write_len_prefixed(w, field, sub.buf[:])
	delete(sub.buf)
}

/** Encode a change; when for_hashing, the id field is omitted. */
encode_change :: proc(c: Change, for_hashing := false, allocator := context.allocator) -> []byte {
	w: Writer
	w.buf = make([dynamic]byte, allocator)
	if for_hashing {
		// protobufjs emits the zeroed id as tag+len(0); hashes must match.
		write_len_prefixed(&w, 1, {})
	} else if len(c.id) > 0 {
		write_len_prefixed(&w, 1, c.id)
	}
	write_string_field(&w, 2, c.object_id)
	for p in c.parent_ids do write_len_prefixed(&w, 3, p)
	for op in c.ops {
		ow: Writer
		encode_operation(op, &ow)
		// ow now holds the Operation message body (its oneof member);
		// wrap it as Change.ops (field 4, length-delimited).
		write_len_prefixed(&w, 4, ow.buf[:])
		delete(ow.buf)
	}
	write_i64_field(&w, 5, c.timestamp)
	write_string_field(&w, 6, c.author)
	return w.buf[:]
}

sha256 :: proc(data: []byte) -> [32]byte {
	ctx: sha2.Context_256
	sha2.init_256(&ctx)
	sha2.update(&ctx, data)
	out: [32]byte
	sha2.final(&ctx, out[:])
	return out
}
