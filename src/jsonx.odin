package glon

// JSON bridge: Object_State/Value/Block ⇄ the wire shapes the Svelte
// app already speaks (ValueJSON/BlockJSON/ObjectJSON in types.ts).

import "core:encoding/json"
import "core:fmt"

// ── Model → json.Value ───────────────────────────────────────────────

jobj :: proc(allocator := context.temp_allocator) -> map[string]json.Value {
	return make(map[string]json.Value, allocator = allocator)
}

value_to_json :: proc(v: Value, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	switch v.kind {
	case .None:
	case .String:
		o["stringValue"] = json.String(v.str)
	case .Int:
		o["intValue"] = json.Integer(v.i)
	case .Float:
		o["floatValue"] = json.Float(v.f)
	case .Bool:
		o["boolValue"] = json.Boolean(v.b)
	case .Bytes:
		o["bytesValue"] = json.String("") // bytes aren't surfaced to the UI
	case .String_List:
		values := make([dynamic]json.Value, allocator)
		for s in v.strings do append(&values, json.String(s))
		inner := jobj(allocator)
		inner["values"] = json.Array(values)
		o["listValue"] = json.Object(inner)
	case .Map:
		entries := jobj(allocator)
		for e in v.entries do entries[e.key] = value_to_json(e.value, allocator)
		inner := jobj(allocator)
		inner["entries"] = json.Object(entries)
		o["mapValue"] = json.Object(inner)
	case .List:
		items := make([dynamic]json.Value, allocator)
		for item in v.items do append(&items, value_to_json(item, allocator))
		inner := jobj(allocator)
		inner["items"] = json.Array(items)
		o["valuesValue"] = json.Object(inner)
	case .Link:
		inner := jobj(allocator)
		inner["targetId"] = json.String(v.link_target)
		inner["relationKey"] = json.String(v.link_relation)
		o["linkValue"] = json.Object(inner)
	}
	return json.Object(o)
}

fields_to_json :: proc(fields: [dynamic]Value_Entry, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	for e in fields do o[e.key] = value_to_json(e.value, allocator)
	return json.Object(o)
}

block_to_json :: proc(b: Block, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	o["id"] = json.String(b.id)
	kids := make([dynamic]json.Value, allocator)
	for c in b.children_ids do append(&kids, json.String(c))
	o["childrenIds"] = json.Array(kids)

	content := jobj(allocator)
	switch b.content.kind {
	case .None:
	case .Text:
		t := jobj(allocator)
		t["text"] = json.String(b.content.text.text)
		t["style"] = json.Integer(b.content.text.style)
		marks := make([dynamic]json.Value, allocator)
		for m in b.content.text.marks {
			mo := jobj(allocator)
			mo["from"] = json.Integer(m.from)
			mo["to"] = json.Integer(m.to)
			mo["type"] = json.Integer(m.type)
			if m.param != "" do mo["param"] = json.String(m.param)
			append(&marks, json.Object(mo))
		}
		t["marks"] = json.Array(marks)
		t["checked"] = json.Boolean(b.content.text.checked)
		t["color"] = json.String(b.content.text.color)
		content["text"] = json.Object(t)
	case .Custom:
		c := jobj(allocator)
		c["contentType"] = json.String(b.content.custom.content_type)
		meta := jobj(allocator)
		for p in b.content.custom.meta do meta[p.key] = json.String(p.value)
		c["meta"] = json.Object(meta)
		content["custom"] = json.Object(c)
	case .Layout:
		l := jobj(allocator)
		l["style"] = json.Integer(b.content.layout_style)
		content["layout"] = json.Object(l)
	}
	o["content"] = json.Object(content)

	if len(b.fields) > 0 {
		fw := jobj(allocator)
		fw["entries"] = fields_to_json(b.fields, allocator)
		o["fields"] = json.Object(fw)
	}
	if b.align != 0 do o["align"] = json.Integer(b.align)
	if b.background_color != "" do o["backgroundColor"] = json.String(b.background_color)
	return json.Object(o)
}

object_to_json_value :: proc(s: ^Object_State, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	o["id"] = json.String(s.id)
	o["typeKey"] = json.String(s.type_key)
	o["fields"] = fields_to_json(s.fields, allocator)
	blocks := make([dynamic]json.Value, allocator)
	for b in s.blocks {
		if b.id == "__content__" do continue // legacy primary-content block stays internal
		append(&blocks, block_to_json(b, allocator))
	}
	o["blocks"] = json.Array(blocks)
	o["deleted"] = json.Boolean(s.deleted)
	o["createdAt"] = json.Integer(s.created_at)
	o["updatedAt"] = json.Integer(s.updated_at)
	return json.Object(o)
}

object_to_json :: proc(s: ^Object_State, allocator := context.temp_allocator) -> []byte {
	out, err := json.marshal(object_to_json_value(s, allocator), allocator = allocator)
	if err != nil do return transmute([]byte)string("{}")
	return out
}

marshal :: proc(v: json.Value, allocator := context.temp_allocator) -> []byte {
	out, err := json.marshal(v, allocator = allocator)
	if err != nil do return transmute([]byte)string("null")
	return out
}

// ── json.Value → model ───────────────────────────────────────────────

json_str :: proc(v: json.Value, key: string) -> string {
	obj, ok := v.(json.Object)
	if !ok do return ""
	field, fok := obj[key]
	if !fok do return ""
	s, sok := field.(json.String)
	return sok ? string(s) : ""
}

json_int :: proc(v: json.Value, key: string) -> (i64, bool) {
	obj, ok := v.(json.Object)
	if !ok do return 0, false
	field, fok := obj[key]
	if !fok do return 0, false
	#partial switch x in field {
	case json.Integer:
		return i64(x), true
	case json.Float:
		return i64(x), true
	}
	return 0, false
}

json_bool :: proc(v: json.Value, key: string) -> (bool, bool) {
	obj, ok := v.(json.Object)
	if !ok do return false, false
	field, fok := obj[key]
	if !fok do return false, false
	b, bok := field.(json.Boolean)
	return bool(b), bok
}

json_field :: proc(v: json.Value, key: string) -> (json.Value, bool) {
	obj, ok := v.(json.Object)
	if !ok do return nil, false
	field, fok := obj[key]
	return field, fok
}

/** Parse a ValueJSON object into a proto Value. */
value_from_json :: proc(v: json.Value, allocator := context.allocator) -> Value {
	out: Value
	obj, ok := v.(json.Object)
	if !ok do return out
	if s, sok := obj["stringValue"]; sok {
		out.kind = .String
		if str, isok := s.(json.String); isok do out.str = string(str)
		return out
	}
	if x, xok := obj["intValue"]; xok {
		out.kind = .Int
		#partial switch n in x {
		case json.Integer:
			out.i = i64(n)
		case json.Float:
			out.i = i64(n)
		}
		return out
	}
	if x, xok := obj["floatValue"]; xok {
		out.kind = .Float
		#partial switch n in x {
		case json.Integer:
			out.f = f64(n)
		case json.Float:
			out.f = f64(n)
		}
		return out
	}
	if x, xok := obj["boolValue"]; xok {
		out.kind = .Bool
		if b, bok := x.(json.Boolean); bok do out.b = bool(b)
		return out
	}
	if x, xok := obj["listValue"]; xok {
		out.kind = .String_List
		out.strings = make([dynamic]string, allocator)
		if inner, iok := json_field(x, "values"); iok {
			if arr, aok := inner.(json.Array); aok {
				for item in arr {
					if s, sok := item.(json.String); sok do append(&out.strings, string(s))
				}
			}
		}
		return out
	}
	if x, xok := obj["mapValue"]; xok {
		out.kind = .Map
		out.entries = make([dynamic]Value_Entry, allocator)
		if inner, iok := json_field(x, "entries"); iok {
			if entries, eok := inner.(json.Object); eok {
				for key, val in entries {
					append(&out.entries, Value_Entry{key = key, value = value_from_json(val, allocator)})
				}
			}
		}
		return out
	}
	if x, xok := obj["valuesValue"]; xok {
		out.kind = .List
		out.items = make([dynamic]Value, allocator)
		if inner, iok := json_field(x, "items"); iok {
			if arr, aok := inner.(json.Array); aok {
				for item in arr do append(&out.items, value_from_json(item, allocator))
			}
		}
		return out
	}
	if x, xok := obj["linkValue"]; xok {
		out.kind = .Link
		out.link_target = json_str(x, "targetId")
		out.link_relation = json_str(x, "relationKey")
		return out
	}
	return out
}

/** Parse a BlockContent JSON object. */
content_from_json :: proc(v: json.Value, allocator := context.allocator) -> Block_Content {
	c: Block_Content
	if t, ok := json_field(v, "text"); ok {
		c.kind = .Text
		c.text.text = json_str(t, "text")
		c.text.style, _ = json_int(t, "style")
		c.text.checked, _ = json_bool(t, "checked")
		c.text.color = json_str(t, "color")
		c.text.marks = make([dynamic]Mark, allocator)
		if marks, mok := json_field(t, "marks"); mok {
			if arr, aok := marks.(json.Array); aok {
				for m in arr {
					mark: Mark
					mark.from, _ = json_int(m, "from")
					mark.to, _ = json_int(m, "to")
					mark.type, _ = json_int(m, "type")
					mark.param = json_str(m, "param")
					append(&c.text.marks, mark)
				}
			}
		}
		return c
	}
	if l, ok := json_field(v, "layout"); ok {
		c.kind = .Layout
		c.layout_style, _ = json_int(l, "style")
		return c
	}
	if cu, ok := json_field(v, "custom"); ok {
		c.kind = .Custom
		c.custom.content_type = json_str(cu, "contentType")
		c.custom.meta = make([dynamic]Str_Pair, allocator)
		return c
	}
	return c
}

/** Parse a BlockJSON object (content + attrs; children from JSON). */
block_from_json :: proc(v: json.Value, allocator := context.allocator) -> Block {
	b: Block
	b.id = json_str(v, "id")
	b.children_ids = make([dynamic]string, allocator)
	if kids, ok := json_field(v, "childrenIds"); ok {
		if arr, aok := kids.(json.Array); aok {
			for k in arr {
				if s, sok := k.(json.String); sok do append(&b.children_ids, string(s))
			}
		}
	}
	if content, ok := json_field(v, "content"); ok {
		b.content = content_from_json(content, allocator)
	}
	b.align, _ = json_int(v, "align")
	b.background_color = json_str(v, "backgroundColor")
	b.fields = make([dynamic]Value_Entry, allocator)
	if fw, ok := json_field(v, "fields"); ok {
		if entries, eok := json_field(fw, "entries"); eok {
			if eobj, eook := entries.(json.Object); eook {
				for key, val in eobj {
					append(&b.fields, Value_Entry{key = key, value = value_from_json(val, allocator)})
				}
			}
		}
	}
	return b
}

/** Parse a fields map {key: ValueJSON}. */
fields_from_json :: proc(v: json.Value, allocator := context.allocator) -> [dynamic]Value_Entry {
	out := make([dynamic]Value_Entry, allocator)
	if obj, ok := v.(json.Object); ok {
		for key, val in obj {
			append(&out, Value_Entry{key = key, value = value_from_json(val, allocator)})
		}
	}
	return out
}
