package core

import "core:encoding/json"
import "core:encoding/base64"
import "core:encoding/hex"

// Ordered pairs are the internal bridge representation for protobuf maps.
// Plain objects remain accepted by native callers; no map sorting is performed.
JSON_Map_Pair :: struct { key: string, value: json.Value }
json_map_pairs :: proc(v: json.Value, allocator := context.allocator) -> [dynamic]JSON_Map_Pair {
	out := make([dynamic]JSON_Map_Pair, allocator)
	#partial switch x in v {
	case json.Object:
		for key, value in x do append(&out, JSON_Map_Pair{key, value})
	case json.Array:
		for item in x {
			if pair, ok := item.(json.Array); ok && len(pair) == 2 {
				if key, ok := pair[0].(json.String); ok do append(&out, JSON_Map_Pair{string(key), pair[1]})
			}
		}
	}
	return out
}

json_array :: proc(v: json.Value, key: string) -> json.Array {
	field, _ := json_field(v, key)
	if arr, ok := field.(json.Array); ok do return arr
	return nil
}

operation_from_json :: proc(v: json.Value, allocator := context.allocator) -> (Operation, bool) {
	op: Operation
	if x, ok := json_field(v, "objectCreate"); ok {
		op.kind, op.type_key = .Object_Create, json_str(x, "typeKey")
	} else if _, ok := json_field(v, "objectDelete"); ok {
		op.kind = .Object_Delete
	} else if x, ok := json_field(v, "fieldSet"); ok {
		op.kind, op.key = .Field_Set, json_str(x, "key")
		value, _ := json_field(x, "value")
		op.value = value_from_json(value, allocator)
		_, present := value.(json.Object)
		op.omit_payload = !present
	} else if x, ok := json_field(v, "fieldDelete"); ok {
		op.kind, op.key = .Field_Delete, json_str(x, "key")
	} else if x, ok := json_field(v, "blockAdd"); ok {
		op.kind = .Block_Add
		op.parent_id = json_str(x, "parentId")
		op.after_id = json_str(x, "afterId")
		op.target_id = json_str(x, "targetId")
		op.position, _ = json_int(x, "position")
		block, _ := json_field(x, "block")
		op.block = block_from_json(block, allocator)
		_, present := block.(json.Object)
		op.omit_payload = !present
	} else if x, ok := json_field(v, "blockRemove"); ok {
		op.kind, op.block_id = .Block_Remove, json_str(x, "blockId")
	} else if x, ok := json_field(v, "blockUpdate"); ok {
		op.kind, op.block_id = .Block_Update, json_str(x, "blockId")
		content, _ := json_field(x, "content")
		op.content = content_from_json(content, allocator)
		_, present := content.(json.Object)
		op.omit_payload = !present
	} else if x, ok := json_field(v, "blockMove"); ok {
		op.kind, op.block_id = .Block_Move, json_str(x, "blockId")
		op.parent_id = json_str(x, "newParentId")
		op.after_id = json_str(x, "afterId")
		op.target_id = json_str(x, "targetId")
		op.position, _ = json_int(x, "position")
	} else if x, ok := json_field(v, "blockSetAlign"); ok {
		op.kind, op.block_id = .Block_Set_Align, json_str(x, "blockId")
		op.align, _ = json_int(x, "align")
	} else if x, ok := json_field(v, "blockSetBackground"); ok {
		op.kind, op.block_id = .Block_Set_Background, json_str(x, "blockId")
		op.color = json_str(x, "color")
	} else if obj, ok := v.(json.Object); !ok || len(obj) != 0 {
		return {}, false
	}
	return op, true
}

operation_to_json :: proc(op: Operation, allocator := context.temp_allocator, ordered := false) -> json.Value {
	o, x := jobj(allocator), jobj(allocator)
	name: string
	switch op.kind {
	case .None:
		return json.Object(o)
	case .Object_Create:
		name = "objectCreate"
		x["typeKey"] = json.String(op.type_key)
	case .Object_Delete:
		name = "objectDelete"
	case .Field_Set:
		name = "fieldSet"
		x["key"] = json.String(op.key)
		if !op.omit_payload do x["value"] = value_to_json(op.value, allocator, ordered)
	case .Field_Delete:
		name = "fieldDelete"
		x["key"] = json.String(op.key)
	case .Block_Add:
		name = "blockAdd"
		x["parentId"] = json.String(op.parent_id)
		x["afterId"] = json.String(op.after_id)
		x["targetId"] = json.String(op.target_id)
		x["position"] = json.Integer(op.position)
		if !op.omit_payload do x["block"] = block_to_json(op.block, allocator, ordered, wire = true)
	case .Block_Remove:
		name = "blockRemove"
		x["blockId"] = json.String(op.block_id)
	case .Block_Update:
		name = "blockUpdate"
		x["blockId"] = json.String(op.block_id)
		if !op.omit_payload {
			block := block_to_json(Block{content = op.content, has_content = true}, allocator, ordered, wire = true)
			x["content"], _ = json_field(block, "content")
		}
	case .Block_Move:
		name = "blockMove"
		x["blockId"] = json.String(op.block_id)
		x["newParentId"] = json.String(op.parent_id)
		x["afterId"] = json.String(op.after_id)
		x["targetId"] = json.String(op.target_id)
		x["position"] = json.Integer(op.position)
	case .Block_Set_Align:
		name = "blockSetAlign"
		x["blockId"] = json.String(op.block_id)
		x["align"] = json.Integer(op.align)
	case .Block_Set_Background:
		name = "blockSetBackground"
		x["blockId"] = json.String(op.block_id)
		x["color"] = json.String(op.color)
	}
	o[name] = json.Object(x)
	return json.Object(o)
}

snapshot_from_json :: proc(v: json.Value, allocator := context.allocator) -> Snapshot {
	s: Snapshot
	s.id, s.type_key = json_str(v, "id"), json_str(v, "typeKey")
	fields, _ := json_field(v, "fields")
	s.fields = fields_from_json(fields, allocator)
	s.content, _ = bytes_from_base64(json_str(v, "content"), allocator)
	s.blocks = make([dynamic]Block, allocator)
	for block in json_array(v, "blocks") do append(&s.blocks, block_from_json(block, allocator))
	s.deleted, _ = json_bool(v, "deleted")
	s.created_at, _ = json_int(v, "createdAt")
	s.updated_at, _ = json_int(v, "updatedAt")
	return s
}

snapshot_to_json :: proc(s: Snapshot, allocator := context.temp_allocator, ordered := false) -> json.Value {
	o := jobj(allocator)
	o["id"], o["typeKey"] = json.String(s.id), json.String(s.type_key)
	o["fields"] = fields_to_json(s.fields, allocator, ordered)
	o["content"] = json.String(base64.encode(s.content, allocator = allocator))
	blocks := make([dynamic]json.Value, allocator)
	for block in s.blocks do append(&blocks, block_to_json(block, allocator, ordered, wire = true))
	o["blocks"] = json.Array(blocks)
	o["deleted"] = json.Boolean(s.deleted)
	o["createdAt"], o["updatedAt"] = json.Integer(s.created_at), json.Integer(s.updated_at)
	return json.Object(o)
}

// The clone ensures no returned string/map key borrows the request parser's arena.
change_from_json :: proc(v: json.Value, allocator := context.allocator) -> (Change, bool) {
	if _, ok := v.(json.Object); !ok do return {}, false
	owned := json.clone_value(v, allocator)
	c: Change
	id, id_ok := hex.decode(transmute([]byte)json_str(owned, "id"), allocator)
	if !id_ok do return {}, false
	c.id = id
	c.object_id, c.author = json_str(owned, "objectId"), json_str(owned, "author")
	c.timestamp, _ = json_int(owned, "timestamp")
	c.parent_ids = make([dynamic][]byte, allocator)
	for item in json_array(owned, "parentIds") {
		s, ok := item.(json.String)
		if !ok do return {}, false
		parent, parent_ok := hex.decode(transmute([]byte)string(s), allocator)
		if !parent_ok do return {}, false
		append(&c.parent_ids, parent)
	}
	c.ops = make([dynamic]Operation, allocator)
	for item in json_array(owned, "ops") {
		op, ok := operation_from_json(item, allocator)
		if !ok do return {}, false
		append(&c.ops, op)
	}
	if snapshot, ok := json_field(owned, "snapshot"); ok {
		if _, present := snapshot.(json.Object); present {
			c.has_snapshot = true
			c.snapshot = snapshot_from_json(snapshot, allocator)
		}
	}
	return c, true
}

change_to_json :: proc(c: Change, allocator := context.temp_allocator, ordered := false) -> json.Value {
	o := jobj(allocator)
	o["id"] = json.String(hex_id(c.id, allocator))
	o["objectId"], o["author"] = json.String(c.object_id), json.String(c.author)
	o["timestamp"] = json.Integer(c.timestamp)
	parents, ops := make([dynamic]json.Value, allocator), make([dynamic]json.Value, allocator)
	for p in c.parent_ids do append(&parents, json.String(hex_id(p, allocator)))
	for op in c.ops do append(&ops, operation_to_json(op, allocator, ordered))
	o["parentIds"], o["ops"] = json.Array(parents), json.Array(ops)
	if c.has_snapshot do o["snapshot"] = snapshot_to_json(c.snapshot, allocator, ordered)
	return json.Object(o)
}

object_from_json :: proc(v: json.Value, allocator := context.allocator, clone_json := true) -> (Object_State, bool) {
	if _, ok := v.(json.Object); !ok do return {}, false
	owned := v
	if clone_json do owned = json.clone_value(v, allocator)
	snapshot := snapshot_from_json(owned, allocator)
	s := Object_State{
		id = snapshot.id, type_key = snapshot.type_key, fields = snapshot.fields,
		blocks = snapshot.blocks, deleted = snapshot.deleted,
		created_at = snapshot.created_at, updated_at = snapshot.updated_at,
		heads = make([dynamic]string, allocator),
	}
	for head in json_array(owned, "heads") {
		if h, ok := head.(json.String); ok do append(&s.heads, string(h))
	}
	return s, true
}

// Caller owns a request arena; all temporary models and return JSON die with it.
codec_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	action := json_str(payload, "action")
	if action == "decode" {
		bytes, bytes_ok := bytes_from_base64(json_str(payload, "bytes"))
		if !bytes_ok do return nil, "invalid base64 change"
		change, ok := decode_change(bytes)
		if !ok do return nil, "invalid protobuf change"
		return change_to_json(change, ordered = true), ""
	}
	if action != "encode" && action != "hash" do return nil, "unknown codec action"
	value, _ := json_field(payload, "change")
	change, ok := change_from_json(value)
	if !ok do return nil, "invalid change JSON"
	preimage := encode_change(change, true)
	digest := sha256(preimage)
	if action == "hash" do return json.String(hex_id(digest[:], context.temp_allocator)), ""
	change.id = digest[:]
	bytes := encode_change(change)
	return json.String(base64.encode(bytes, allocator = context.temp_allocator)), ""
}

bytes_from_base64 :: proc(s: string, allocator := context.allocator) -> ([]byte, bool) {
	padding := 0
	for ch, i in s {
		if ch == '=' {
			padding += 1
			if i < len(s) - 2 || padding > 2 do return nil, false
		} else {
			if padding > 0 || !(ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '+' || ch == '/') do return nil, false
		}
	}
	if len(s) % 4 == 1 || padding > 0 && (len(s) < 4 || len(s) % 4 != 0) do return nil, false
	decoded, err := base64.decode(s, allocator = allocator)
	return decoded, err == nil
}
