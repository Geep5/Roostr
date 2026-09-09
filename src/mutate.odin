package glon

// Platform shell: store locking, durable commits, publication, keys and identity.
import "../core"
import "core:net"
import "core:os"
import "core:fmt"
import "core:sync"
import "core:path/filepath"
import "core:encoding/json"
import "core:encoding/hex"
import "core:crypto"

make_change :: proc(object_id: string, ops: []core.Operation, author := "glon-odin") -> core.Change {
	c: core.Change
	c.object_id = object_id
	c.ops = make([dynamic]core.Operation, context.temp_allocator)
	append(&c.ops, ..ops)
	c.parent_ids = object_heads(object_id)
	c.timestamp = unix_ms()
	c.author = author
	return c
}

commit_ops :: proc(object_id: string, ops: []core.Operation) -> bool {
	c := make_change(object_id, ops)
	_, ok := commit_change(&c)
	if ok do sse_broadcast(object_id)
	return ok
}

// Planning happens under the store lock; only request-owned plans escape it.
native_mutation_plan :: proc(parsed: json.Value, key_id := i64(0)) -> (core.Mutation_Plan, string) {
 Request :: struct {
  parsed: json.Value,
  input: core.Mutation_Input,
  plan: core.Mutation_Plan,
  error: string,
 }
 request := Request{parsed = parsed, input = core.Mutation_Input{
  timestamp = unix_ms(), author = author_id(),
  id_seed = new_uuid(context.temp_allocator), key_id = key_id,
 }}
 with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
  r := cast(^Request)user
  r.input.states = states
  r.plan, r.error = core.mutation_plan(r.parsed, r.input)
 }, &request)
 return request.plan, request.error
}

native_commit_plan :: proc(plan: ^core.Mutation_Plan, create_channel := false) -> bool {
 for &change, index in plan.changes {
  change.parent_ids = object_heads(change.object_id)
  // Preserve the native change author; chat attribution is an explicit planner input.
  change.author = "glon-odin"
  _, ok := commit_change(&change)
  if !ok do return false
  sse_broadcast(change.object_id)
  if create_channel && index == 0 do channel_key_set(change.object_id, 1)
 }
 return true
}

handle_mutate :: proc(sock: net.TCP_Socket, body: []byte) {
 if !core.json_depth_ok(body) {
  respond_error(sock, "bad json")
  return
 }
 parsed, perr := json.parse(body, allocator = context.temp_allocator)
 if perr != nil {
  respond_error(sock, "bad json")
  return
 }
 action := core.json_str(parsed, "action")
 // Identity and relay configuration are deliberately platform-only.
 switch action {
 case "nostr_key_export": mutate_key_export(sock); return
 case "nostr_relays_set": mutate_relays_set(sock, parsed); return
 case "nostr_key_import": mutate_key_import(sock, parsed); return
 case "identity_logout": mutate_identity_logout(sock); return
 }
 key_id: i64
 rotating := action == "channel_member_remove" || action == "channel_key_rotate"
 if rotating {
  _, current, found := channel_key_get(core.json_str(parsed, "channel_id"))
  key_id = found ? current + 1 : 1
 }
 plan, err := native_mutation_plan(parsed, key_id)
 if err != "" {
  respond_error(sock, err)
  return
 }
 // Validate the entire pure plan before changing capability material.
 if rotating do channel_key_set(core.json_str(parsed, "channel_id"), key_id)
 if !native_commit_plan(&plan, action == "channel_create") {
  respond_error(sock, "write failed", "500 Internal Server Error")
  return
 }
 if len(plan.vanish_ids) > 0 {
  count := vanish_objects(plan.vanish_ids[:])
  if count == 0 && action == "vanish" {
   respond_error(sock, "vanish failed", "500 Internal Server Error")
   return
  }
  if action == "vanish" do plan.result["vanished"] = json.Integer(i64(count))
  if action == "purge_deleted" do plan.result["purged"] = json.Integer(i64(count))
 }
 plan.result["ok"] = json.Boolean(true)
 respond_json(sock, json.Object(plan.result))
}

seed_space_defaults :: proc(channel_id: string) {
 params := core.jobj()
 params["action"] = json.String("seed_space_defaults")
 params["channel_id"] = json.String(channel_id)
 plan, err := native_mutation_plan(json.Object(params))
 if err != "" || !native_commit_plan(&plan) do fmt.eprintfln("[glon-odin] seeding space defaults failed: %s", err)
}

bootstrap_space_defaults :: proc() {
 params := core.jobj()
 params["action"] = json.String("bootstrap_space_defaults")
 plan, err := native_mutation_plan(json.Object(params))
 if err != "" || !native_commit_plan(&plan) do fmt.eprintfln("[glon-odin] bootstrapping space defaults failed: %s", err)
}

// ── Channel keys (<data>/channel-keys.json) ──────────────────────────

channel_keys_path :: proc() -> string {
	p, _ := filepath.join({g_store.data_root, "channel-keys.json"}, context.temp_allocator)
	return p
}

g_keys_mu: sync.Mutex

channel_keys_read :: proc() -> json.Value {
	// Mirror the api-token pattern: re-tighten an existing file to owner-only on read.
	file, oerr := os.open(channel_keys_path())
	if oerr != nil do return nil
	defer os.close(file)
	_ = os.fchmod(file, {.Read_User, .Write_User})
	data, rerr := os.read_entire_file(file, context.temp_allocator)
	if rerr != nil do return nil
	parsed, perr := json.parse(data, allocator = context.temp_allocator)
	if perr != nil do return nil
	return parsed
}

channel_key_get :: proc(channel_id: string) -> (key: string, key_id: i64, found: bool) {
	sync.lock(&g_keys_mu)
	defer sync.unlock(&g_keys_mu)
	file := channel_keys_read()
	channels, ok := core.json_field(file, "channels")
	if !ok do return "", 0, false
	entry, eok := core.json_field(channels, channel_id)
	if !eok do return "", 0, false
	kid, _ := core.json_int(entry, "keyId")
	return core.json_str(entry, "key"), kid, true
}

channel_key_write :: proc(channel_id: string, key_hex: string, key_id: i64) {
	file := channel_keys_read()
	root := core.jobj()
	if obj, ok := file.(json.Object); ok {
		for k, v in obj do root[k] = v
	}
	root["version"] = json.Integer(1)
	channels := core.jobj()
	if existing, ok := core.json_field(file, "channels"); ok {
		if obj, ook := existing.(json.Object); ook {
			for k, v in obj do channels[k] = v
		}
	}
	entry := core.jobj()
	if previous, ok := channels[channel_id].(json.Object); ok {
		for k, v in previous do entry[k] = v
	}
	entry["key"] = json.String(key_hex)
	entry["keyId"] = json.Integer(key_id)
	entry["createdAt"] = json.Integer(unix_ms())
	channels[channel_id] = json.Object(entry)
	root["channels"] = json.Object(channels)
	// Channel keys are shared secrets — owner-only, like nostr.json.
	_ = os.write_entire_file(channel_keys_path(), core.marshal(json.Object(root)), perm = {.Read_User, .Write_User})
}

channel_key_set :: proc(channel_id: string, key_id: i64) {
	sync.lock(&g_keys_mu)
	defer sync.unlock(&g_keys_mu)
	raw: [32]byte
	crypto.rand_bytes(raw[:])
	channel_key_write(channel_id, string(hex.encode(raw[:], context.temp_allocator)), key_id)
}

channel_key_rotate :: proc(channel_id: string) -> i64 {
	_, key_id, found := channel_key_get(channel_id)
	next := found ? key_id + 1 : 1
	channel_key_set(channel_id, next)
	return next
}
