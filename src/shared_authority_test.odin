package glon

import "../core"

import "core:testing"

@(test)
shared_authority_scope_and_privilege :: proc(t: ^testing.T) {
	owner := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	writer := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	states := make(map[string]^core.Object_State, context.temp_allocator)
	space := core.Object_State{id = "space-a", type_key = "channel", fields = make([dynamic]core.Value_Entry, context.temp_allocator)}
	member := core.Value{kind = .Map, entries = make([dynamic]core.Value_Entry, context.temp_allocator)}
	append(&member.entries, core.Value_Entry{"npub", core.Value{kind = .String, str = writer}}, core.Value_Entry{"role", core.Value{kind = .String, str = "writer"}})
	members := core.Value{kind = .List, items = make([dynamic]core.Value, context.temp_allocator)}
	append(&members.items, member)
	append(&space.fields, core.Value_Entry{"members", members})
	states[space.id] = &space
	foreign_object := core.Object_State{id = "foreign", type_key = "page", fields = make([dynamic]core.Value_Entry, context.temp_allocator)}
	append(&foreign_object.fields, core.Value_Entry{"channel", core.Value{kind = .String, str = "space-b"}})
	states[foreign_object.id] = &foreign_object
	p := Shared_Provenance{"space-a", 1, writer}
	c := core.Change{object_id = "foreign", author = owner, ops = make([dynamic]core.Operation, context.temp_allocator)}
	append(&c.ops, core.Operation{kind = .Field_Set, key = "channel", value = core.Value{kind = .String, str = "space-a"}})
	testing.expect(t, !shared_change_allowed(&c, p, owner, states), "incoming channel stamp and forged inner author cannot capture foreign target")
	c.object_id = "new-page"
	append(&c.ops, core.Operation{kind = .Object_Create, type_key = "page"})
	testing.expect(t, shared_change_allowed(&c, p, owner, states), "member may create explicitly scoped ordinary object")
	c.object_id = "space-a"
	clear(&c.ops)
	append(&c.ops, core.Operation{kind = .Field_Set, key = "members", value = members})
	testing.expect(t, !shared_change_allowed(&c, p, owner, states), "member cannot edit membership")
	p.signer = owner
	testing.expect(t, shared_change_allowed(&c, p, owner, states), "installed owner may edit membership")
	c.object_id = VANISH_LOG_ID
	testing.expect(t, !shared_change_allowed(&c, p, owner, states), "shared owner cannot inject global vanish ledger")
}

@(test)
shared_authority_snapshot_and_batch_revocation :: proc(t: ^testing.T) {
	owner := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	writer := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	states := make(map[string]^core.Object_State, context.temp_allocator)
	space := core.Object_State{id = "space-a", type_key = "channel", fields = make([dynamic]core.Value_Entry, context.temp_allocator)}
	member := core.Value{kind = .Map, entries = make([dynamic]core.Value_Entry, context.temp_allocator)}
	append(&member.entries, core.Value_Entry{"npub", core.Value{kind = .String, str = writer}}, core.Value_Entry{"role", core.Value{kind = .String, str = "writer"}})
	members := core.Value{kind = .List, items = make([dynamic]core.Value, context.temp_allocator)}
	append(&members.items, member)
	append(&space.fields, core.Value_Entry{"members", members})
	states[space.id] = &space
	p := Shared_Provenance{"space-a", 1, writer}
	c := core.Change{object_id = space.id, has_snapshot = true, snapshot = core.Snapshot{id = space.id, type_key = "channel", fields = make([dynamic]core.Value_Entry, context.temp_allocator)}}
	testing.expect(t, !shared_change_allowed(&c, p, owner, states), "snapshot omission cannot erase members")
	append(&c.snapshot.fields, core.Value_Entry{"members", members})
	testing.expect(t, shared_change_allowed(&c, p, owner, states), "member snapshot preserves protected state")
	c.ops = make([dynamic]core.Operation, context.temp_allocator)
	append(&c.ops, core.Operation{kind = .Field_Delete, key = "members"})
	testing.expect(t, !shared_change_allowed(&c, p, owner, states), "snapshot cannot mask forbidden operations")
	clear(&c.ops)
	clear(&space.fields)
	testing.expect(t, !shared_change_allowed(&c, p, owner, states), "next item uses revoked membership rather than cached writer grant")
	p.signer = owner
	c.object_id = "new-page"
	c.snapshot.id = c.object_id
	c.snapshot.type_key = "page"
	clear(&c.snapshot.fields)
	append(&c.snapshot.fields, core.Value_Entry{"channel", core.Value{kind = .String, str = p.space_id}}, core.Value_Entry{"channel", core.Value{kind = .String, str = "space-b"}})
	testing.expect(t, !shared_change_allowed(&c, p, owner, states), "duplicate snapshot field cannot make validation and replay disagree")
}
