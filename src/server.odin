package glon

// Minimal HTTP/1.1 server over core:net — JSON API + SSE for the
// Svelte SPA. One thread per connection; state access serialized
// through the store lock; SSE clients broadcast on every commit.

import "core:net"
import "core:thread"
import "core:time"
import "core:strings"
import "core:strconv"
import "core:sync"
import "core:fmt"
import "core:os"
import "core:mem"
import "core:crypto"
import "core:path/filepath"
import "core:encoding/json"
import "core:encoding/hex"

// ── SSE hub ──────────────────────────────────────────────────────────

Sse_Hub :: struct {
	mu:      sync.Mutex,
	clients: [dynamic]net.TCP_Socket,
}

g_sse: Sse_Hub

sse_broadcast :: proc(object_id: string) {
	msg := fmt.tprintf("data: {{\"objectId\":\"%s\"}}\n\n", object_id)
	sync.lock(&g_sse.mu)
	defer sync.unlock(&g_sse.mu)
	for i := len(g_sse.clients) - 1; i >= 0; i -= 1 {
		_, err := net.send_tcp(g_sse.clients[i], transmute([]byte)msg)
		if err != nil {
			net.close(g_sse.clients[i])
			unordered_remove(&g_sse.clients, i)
		}
	}
}

// Reap dead SSE clients: a comment line every 15s forces a write, so
// sockets whose page is gone error out and get closed. Without this,
// zombie streams pile up and exhaust the browser's 6-per-host pool.
sse_ping_loop :: proc() {
	for {
		time.sleep(15 * time.Second)
		ping := ": ping\n\n"
		sync.lock(&g_sse.mu)
		for i := len(g_sse.clients) - 1; i >= 0; i -= 1 {
			_, err := net.send_tcp(g_sse.clients[i], transmute([]byte)ping)
			if err != nil {
				net.close(g_sse.clients[i])
				unordered_remove(&g_sse.clients, i)
			}
		}
		n := len(g_sse.clients)
		sync.unlock(&g_sse.mu)
		when #config(GLON_HTTP_TRACE, false) {
			fmt.eprintfln("[sse] %d client(s)", n)
		}
	}
}

// ── Request plumbing ─────────────────────────────────────────────────

Request :: struct {
	method: string,
	path:   string,
	body:   []byte,
}

CORS :: "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n"

/** send_tcp may write fewer bytes than asked; loop until done or error.
 * A short write silently truncates an HTTP response — the client then
 * waits for the promised Content-Length remainder forever. */
send_all :: proc(sock: net.TCP_Socket, data: []byte) -> bool {
	sent := 0
	for sent < len(data) {
		n, err := net.send_tcp(sock, data[sent:])
		if err != nil || n <= 0 do return false
		sent += n
	}
	return true
}

respond :: proc(sock: net.TCP_Socket, status: string, content_type: string, body: []byte) {
	head := fmt.tprintf(
		"HTTP/1.1 %s\r\n%sContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n",
		status, CORS, content_type, len(body),
	)
	hok := send_all(sock, transmute([]byte)head)
	bok := hok && send_all(sock, body)
	when #config(GLON_HTTP_TRACE, false) {
		fmt.eprintfln("[trace] respond fd=%d status=%s head=%v body=%v len=%d", sock, status, hok, bok, len(body))
	}
}

respond_json :: proc(sock: net.TCP_Socket, v: json.Value, status := "200 OK") {
	respond(sock, status, "application/json", marshal(v))
}

respond_error :: proc(sock: net.TCP_Socket, message: string, status := "400 Bad Request") {
	o := jobj()
	o["ok"] = json.Boolean(false)
	o["error"] = json.String(message)
	respond_json(sock, json.Object(o), status)
}

serve :: proc(port: int) {
	endpoint := net.Endpoint{address = net.IP4_Address{127, 0, 0, 1}, port = port}
	sock, err := net.listen_tcp(endpoint)
	if err != nil {
		fmt.eprintln("[glon-odin] listen failed:", err)
		os.exit(1)
	}
	fmt.printfln("[glon-odin] listening on http://127.0.0.1:%d (data: %s)", port, g_store.data_root)

	pinger := thread.create_and_start(sse_ping_loop)
	_ = pinger

	for {
		client, _, aerr := net.accept_tcp(sock)
		if aerr != nil do continue
		when #config(GLON_HTTP_TRACE, false) {
			fmt.eprintfln("[trace] accepted fd=%d", client)
		}
		// self_cleanup: the thread detaches and frees its own ^Thread on exit.
		// Without it every connection leaks a pthread (stack region kept until join).
		thread.run_with_poly_data(client, handle_connection)
	}
}

handle_connection :: proc(sock: net.TCP_Socket) {
	arena: mem.Dynamic_Arena
	mem.dynamic_arena_init(&arena)
	context.temp_allocator = mem.dynamic_arena_allocator(&arena)
	defer mem.dynamic_arena_destroy(&arena)

	req, ok := read_request(sock)
	when #config(GLON_HTTP_TRACE, false) {
		fmt.eprintfln("[trace] read fd=%d ok=%v", sock, ok)
	}
	if !ok {
		net.close(sock)
		return
	}

	if req.method == "OPTIONS" {
		respond(sock, "204 No Content", "text/plain", {})
		net.close(sock)
		return
	}

	// SSE keeps the socket; everything else closes after responding.
	if req.method == "GET" && req.path == "/api/events" {
		when #config(GLON_HTTP_TRACE, false) {
			fmt.eprintfln("[trace] SSE subscribe")
		}
		head := fmt.tprintf("HTTP/1.1 200 OK\r\n%sContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\ndata: {{\"hello\":true}}\n\n", CORS)
		if send_all(sock, transmute([]byte)head) {
			sync.lock(&g_sse.mu)
			// Bound zombie pileup: a client that stops reading but keeps the
			// socket open (abandoned headless pages) is indistinguishable from
			// a healthy idle one - evict the oldest past a sane cap.
			if len(g_sse.clients) >= 64 {
				net.close(g_sse.clients[0])
				ordered_remove(&g_sse.clients, 0)
			}
			append(&g_sse.clients, sock)
			sync.unlock(&g_sse.mu)
		} else {
			net.close(sock)
		}
		return
	}

	when #config(GLON_HTTP_TRACE, false) {
		fmt.eprintfln("[trace] fd=%d %s %s", sock, req.method, req.path)
	}
	route(sock, req)
	net.close(sock)
	when #config(GLON_HTTP_TRACE, false) {
		fmt.eprintfln("[trace] closed fd=%d", sock)
	}
}

read_request :: proc(sock: net.TCP_Socket) -> (Request, bool) {
	buf := make([dynamic]byte, context.temp_allocator)
	chunk: [8192]byte
	header_end := -1
	for header_end < 0 {
		n, err := net.recv_tcp(sock, chunk[:])
		if err != nil || n == 0 do return {}, false
		append(&buf, ..chunk[:n])
		header_end = strings.index(string(buf[:]), "\r\n\r\n")
		if len(buf) > 1 << 20 do return {}, false
	}

	head := string(buf[:header_end])
	lines := strings.split_lines(head, context.temp_allocator)
	if len(lines) == 0 do return {}, false
	parts := strings.split(lines[0], " ", context.temp_allocator)
	if len(parts) < 2 do return {}, false

	content_length := 0
	for line in lines[1:] {
		lower := strings.to_lower(line, context.temp_allocator)
		if strings.has_prefix(lower, "content-length:") {
			v := strings.trim_space(line[len("content-length:"):])
			content_length, _ = strconv.parse_int(v)
		}
	}

	body_start := header_end + 4
	for len(buf) - body_start < content_length {
		n, err := net.recv_tcp(sock, chunk[:])
		if err != nil || n == 0 do break
		append(&buf, ..chunk[:n])
	}

	req: Request
	req.method = parts[0]
	// Strip query string.
	path := parts[1]
	if qi := strings.index_byte(path, '?'); qi >= 0 do path = path[:qi]
	req.path = path
	req.body = buf[body_start:min(len(buf), body_start + content_length)]
	return req, true
}

// ── Routing ──────────────────────────────────────────────────────────

route :: proc(sock: net.TCP_Socket, req: Request) {
	switch {
	case req.method == "GET" && req.path == "/api/objects":
		handle_list_objects(sock)
	case req.method == "GET" && strings.has_prefix(req.path, "/api/objects/"):
		handle_get_object(sock, req.path[len("/api/objects/"):])
	case req.method == "GET" && req.path == "/api/sync/digest":
		handle_sync_digest(sock)
	case req.method == "GET" && req.path == "/api/changes":
		handle_changes_manifest(sock)
	case req.method == "GET" && strings.has_prefix(req.path, "/api/changes/"):
		handle_changes_get(sock, req.path[len("/api/changes/"):])
	case req.method == "POST" && req.path == "/api/changes":
		handle_changes_import(sock, req.body)
	case req.method == "GET" && req.path == "/api/vanished":
		handle_vanished(sock)
	case req.method == "GET" && req.path == "/api/settings":
		handle_settings(sock)
	case req.method == "GET" && req.path == "/api/relations":
		handle_relations(sock)
	case req.method == "GET" && req.path == "/api/channels":
		handle_channels(sock)
	case req.method == "POST" && req.path == "/api/query":
		handle_query(sock, req.body)
	case req.method == "POST" && req.path == "/api/mutate":
		handle_mutate(sock, req.body)
	case:
		respond_error(sock, "not found", "404 Not Found")
	}
}

HIDDEN_LIST_TYPES :: []string{"program", "typescript", "json", "proto", "relation", "channel", "skill", "peer", "pinned_fact", "milestone", "agent", VANISH_LOG_TYPE}

handle_list_objects :: proc(sock: net.TCP_Socket) {
	Ctx :: struct {
		sock: net.TCP_Socket,
	}
	ctx := Ctx{sock}
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
		sock := (cast(^struct {
				sock: net.TCP_Socket,
			})user).sock
		arr := make([dynamic]json.Value, context.temp_allocator)
		for _, s in states {
			if s.deleted do continue
			hidden := false
			for t in HIDDEN_LIST_TYPES do if s.type_key == t {
				hidden = true
				break
			}
			if hidden do continue
			o := jobj()
			o["id"] = json.String(s.id)
			o["typeKey"] = json.String(s.type_key)
			name := ""
			if v, ok := fields_get(s.fields, "name"); ok && v.kind == .String do name = v.str
			o["name"] = json.String(name)
			o["updatedAt"] = json.Integer(s.updated_at)
			channel_id := ""
			if v, ok := fields_get(s.fields, "channel"); ok && v.kind == .String do channel_id = v.str
			o["channelId"] = json.String(channel_id)
			emoji := ""
			if v, ok := fields_get(s.fields, "iconEmoji"); ok && v.kind == .String do emoji = v.str
			o["icon"] = json.String(emoji)
			append(&arr, json.Object(o))
		}
		// Newest first.
		g_sorts = make([dynamic]Sort_Spec, context.temp_allocator)
		sort_summaries(&arr)
		respond_json(sock, json.Array(arr))
	}, &ctx)
}

sort_summaries :: proc(arr: ^[dynamic]json.Value) {
	// insertion sort by updatedAt desc (lists are small)
	for i in 1 ..< len(arr) {
		j := i
		for j > 0 {
			a, _ := json_int(arr[j - 1], "updatedAt")
			b, _ := json_int(arr[j], "updatedAt")
			if a >= b do break
			arr[j - 1], arr[j] = arr[j], arr[j - 1]
			j -= 1
		}
	}
}

handle_get_object :: proc(sock: net.TCP_Socket, id: string) {
	Ctx :: struct {
		sock: net.TCP_Socket,
		id:   string,
	}
	ctx := Ctx{sock, id}
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^struct {
			sock: net.TCP_Socket,
			id:   string,
		})user
		s, ok := states[c.id]
		if !ok {
			respond_error(c.sock, "no object", "404 Not Found")
			return
		}
		respond_json(c.sock, object_to_json_value(s))
	}, &ctx)
}

handle_relations :: proc(sock: net.TCP_Socket) {
	Ctx :: struct {
		sock: net.TCP_Socket,
	}
	ctx := Ctx{sock}
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
		sock := (cast(^struct {
				sock: net.TCP_Socket,
			})user).sock
		arr := make([dynamic]json.Value, context.temp_allocator)
		for _, s in states {
			if s.type_key != "relation" || s.deleted do continue
			o := jobj()
			o["id"] = json.String(s.id)
			str := proc(s: ^Object_State, k: string) -> string {
				if v, ok := fields_get(s.fields, k); ok && v.kind == .String do return v.str
				return ""
			}
			o["key"] = json.String(str(s, "key"))
			o["format"] = json.String(str(s, "format"))
			o["name"] = json.String(str(s, "name"))
			hidden := false
			if v, ok := fields_get(s.fields, "hidden"); ok && v.kind == .Bool do hidden = v.b
			o["hidden"] = json.Boolean(hidden)
			read_only := false
			if v, ok := fields_get(s.fields, "readOnly"); ok && v.kind == .Bool do read_only = v.b
			o["readOnly"] = json.Boolean(read_only)
			max_count: i64 = 0
			if v, ok := fields_get(s.fields, "maxCount"); ok && v.kind == .Int do max_count = v.i
			o["maxCount"] = json.Integer(max_count)
			options := make([dynamic]json.Value, context.temp_allocator)
			if v, ok := fields_get(s.fields, "options"); ok && v.kind == .List {
				for item in v.items {
					if item.kind != .Map do continue
					oo := jobj()
					for e in item.entries {
						if e.value.kind == .String do oo[e.key] = json.String(e.value.str)
					}
					append(&options, json.Object(oo))
				}
			}
			o["options"] = json.Array(options)
			append(&arr, json.Object(o))
		}
		respond_json(sock, json.Array(arr))
	}, &ctx)
}

handle_channels :: proc(sock: net.TCP_Socket) {
	Ctx :: struct {
		sock: net.TCP_Socket,
	}
	ctx := Ctx{sock}
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
		sock := (cast(^struct {
				sock: net.TCP_Socket,
			})user).sock
		arr := make([dynamic]json.Value, context.temp_allocator)
		for _, s in states {
			if s.type_key != "channel" || s.deleted do continue
			o := jobj()
			o["id"] = json.String(s.id)
			name := ""
			if v, ok := fields_get(s.fields, "name"); ok && v.kind == .String do name = v.str
			o["name"] = json.String(name)
		// Anytype precedence: image wins over emoji, else caller falls back
		// to the first letter (their generated-tile equivalent).
		icon := ""
		if v, ok := fields_get(s.fields, "iconImage"); ok && v.kind == .String do icon = v.str
		if icon == "" {
			if v, ok := fields_get(s.fields, "iconEmoji"); ok && v.kind == .String do icon = v.str
		}
		o["icon"] = json.String(icon)
			pinned := make([dynamic]json.Value, context.temp_allocator)
			if v, ok := fields_get(s.fields, "pinnedIds"); ok && v.kind == .List {
				for item in v.items do if item.kind == .String do append(&pinned, json.String(item.str))
			}
			o["pinnedIds"] = json.Array(pinned)
			members := make([dynamic]json.Value, context.temp_allocator)
			if v, ok := fields_get(s.fields, "members"); ok && v.kind == .List {
				for item in v.items {
					if item.kind != .Map do continue
					mo := jobj()
					for e in item.entries do if e.value.kind == .String do mo[e.key] = json.String(e.value.str)
					append(&members, json.Object(mo))
				}
			}
			o["members"] = json.Array(members)
			key_id: i64 = 0
			if v, ok := fields_get(s.fields, "keyId"); ok && v.kind == .Int do key_id = v.i
			o["keyId"] = json.Integer(key_id)
			append(&arr, json.Object(o))
		}
		// Deterministic order: name ascending (map iteration is random).
		for i in 1 ..< len(arr) {
			j := i
			for j > 0 && strings.compare(json_str(arr[j - 1], "name"), json_str(arr[j], "name")) > 0 {
				arr[j - 1], arr[j] = arr[j], arr[j - 1]
				j -= 1
			}
		}
		respond_json(sock, json.Array(arr))
	}, &ctx)
}

handle_query :: proc(sock: net.TCP_Socket, body: []byte) {
	parsed, perr := json.parse(body, allocator = context.temp_allocator)
	if perr != nil {
		respond_error(sock, "bad json")
		return
	}
	Ctx :: struct {
		sock: net.TCP_Socket,
		body: json.Value,
	}
	ctx := Ctx{sock, parsed}
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^struct {
			sock: net.TCP_Socket,
			body: json.Value,
		})user

		// setId: resolve the set's sources into an extra filter.
		extra: json.Value
		set_id := json_str(c.body, "setId")
		if set_id != "" {
			if set_obj, ok := states[set_id]; ok {
				extra = resolve_set_filter(states, set_obj)
			}
		}

		matched := run_query(states, c.body, extra)
		text := json_str(c.body, "textQuery")
		records := make([dynamic]json.Value, context.temp_allocator)
		for s in matched {
			o := jobj()
			o["id"] = json.String(s.id)
			o["typeKey"] = json.String(s.type_key)
			name := ""
			if v, ok := fields_get(s.fields, "name"); ok && v.kind == .String do name = v.str
			o["name"] = json.String(name)
			o["fields"] = fields_to_json(s.fields)
			o["createdAt"] = json.Integer(s.created_at)
			o["updatedAt"] = json.Integer(s.updated_at)
			if s.deleted do o["deleted"] = json.Boolean(true)
			if text != "" {
				snippet := text_snippet(s, text)
				if snippet != "" do o["snippet"] = json.String(snippet)
			}
			append(&records, json.Object(o))
		}
		out := jobj()
		out["total"] = json.Integer(i64(len(records)))
		out["records"] = json.Array(records)
		respond_json(c.sock, json.Object(out))
	}, &ctx)
}

/** Anytype resolveSources: type keys → type-in; relation keys → exists; OR. */
resolve_set_filter :: proc(states: map[string]^Object_State, set_obj: ^Object_State) -> json.Value {
	sources := make([dynamic]string, context.temp_allocator)
	if v, ok := fields_get(set_obj.fields, "setOf"); ok && v.kind == .List {
		for item in v.items do if item.kind == .String do append(&sources, item.str)
	}
	if len(sources) == 0 do return nil

	relation_keys := make(map[string]bool, allocator = context.temp_allocator)
	for _, s in states {
		if s.type_key != "relation" do continue
		if v, ok := fields_get(s.fields, "key"); ok && v.kind == .String do relation_keys[v.str] = true
	}

	parts := make([dynamic]json.Value, context.temp_allocator)
	type_values := make([dynamic]json.Value, context.temp_allocator)
	for src in sources {
		if relation_keys[src] {
			f := jobj()
			f["key"] = json.String(src)
			f["condition"] = json.String("exists")
			append(&parts, json.Object(f))
		} else {
			append(&type_values, json.String(src))
		}
	}
	if len(type_values) > 0 {
		f := jobj()
		f["key"] = json.String("type")
		f["condition"] = json.String("in")
		f["value"] = json.Array(type_values)
		append(&parts, json.Object(f))
	}
	if len(parts) == 1 do return parts[0]
	group := jobj()
	group["operator"] = json.String("or")
	group["nested"] = json.Array(parts)
	return json.Object(group)
}
