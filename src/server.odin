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
import "../core"
// ── SSE hub ──────────────────────────────────────────────────────────

Sse_Client :: struct { sock: net.TCP_Socket, expires: i64 }
Sse_Hub :: struct {
	mu:      sync.Mutex,
	clients: [dynamic]Sse_Client,
}

g_sse: Sse_Hub

sse_broadcast :: proc(object_id: string) {
	msg := fmt.tprintf("data: {{\"objectId\":\"%s\"}}\n\n", object_id)
	sync.lock(&g_sse.mu)
	defer sync.unlock(&g_sse.mu)
	for i := len(g_sse.clients) - 1; i >= 0; i -= 1 {
		client := g_sse.clients[i]
		if client.expires <= unix_ms() || !send_all(client.sock, transmute([]byte)msg) {
			net.close(client.sock)
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
			client := g_sse.clients[i]
			if client.expires <= unix_ms() || !send_all(client.sock, transmute([]byte)ping) {
				net.close(client.sock)
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
	host, origin, authorization: string,
}

// Response CORS is set per connection only after origin authorization.

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
		"HTTP/1.1 %s\r\n%sContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
		status, g_response_cors, content_type, len(body),
	)
	hok := send_all(sock, transmute([]byte)head)
	bok := hok && send_all(sock, body)
	when #config(GLON_HTTP_TRACE, false) {
		fmt.eprintfln("[trace] respond fd=%d status=%s head=%v body=%v len=%d", sock, status, hok, bok, len(body))
	}
}

respond_json :: proc(sock: net.TCP_Socket, v: json.Value, status := "200 OK") {
	respond(sock, status, "application/json", core.marshal(v))
}

respond_error :: proc(sock: net.TCP_Socket, message: string, status := "400 Bad Request") {
	o := core.jobj()
	o["ok"] = json.Boolean(false)
	o["error"] = json.String(message)
	respond_json(sock, json.Object(o), status)
}

serve :: proc(port: int) {
	local_auth_init(port)
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

	if !local_authorize(sock, req) {
		net.close(sock)
		return
	}

	// SSE keeps the socket; everything else closes after responding.
	if req.method == "GET" && req.path == "/api/events" {
		when #config(GLON_HTTP_TRACE, false) {
			fmt.eprintfln("[trace] SSE subscribe")
		}
		head := fmt.tprintf("HTTP/1.1 200 OK\r\n%sContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\ndata: {{\"hello\":true}}\n\n", g_response_cors)
		if send_all(sock, transmute([]byte)head) {
			sync.lock(&g_sse.mu)
			// Bound zombie pileup: a client that stops reading but keeps the
			// socket open (abandoned headless pages) is indistinguishable from
			// a healthy idle one - evict the oldest past a sane cap.
			if len(g_sse.clients) >= 64 {
				net.close(g_sse.clients[0].sock)
				ordered_remove(&g_sse.clients, 0)
			}
			append(&g_sse.clients, Sse_Client{sock, g_session_expires})
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

parse_request_head :: proc(head: string) -> (req: Request, content_length: int, ok: bool) {
	lines := strings.split(head, "\r\n", context.temp_allocator)
	if len(lines) == 0 do return {}, 0, false
	parts := strings.split(lines[0], " ", context.temp_allocator)
	if len(parts) != 3 || parts[2] != "HTTP/1.1" || !strings.has_prefix(parts[1], "/") || strings.has_prefix(parts[1], "//") do return {}, 0, false
	if parts[0] != "GET" && parts[0] != "POST" && parts[0] != "OPTIONS" do return {}, 0, false
	req.method = parts[0]
	req.path = parts[1]
	if qi := strings.index_byte(req.path, '?'); qi >= 0 do req.path = req.path[:qi]
	seen := make(map[string]bool, context.temp_allocator)
	for line in lines[1:] {
		colon := strings.index_byte(line, ':')
		if colon <= 0 do return {}, 0, false
		name := strings.to_lower(line[:colon], context.temp_allocator)
		for c in name do if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') do return {}, 0, false
		value := strings.trim_space(line[colon+1:])
		for c in value do if c < 32 || c == 127 do return {}, 0, false
		if seen[name] do return {}, 0, false
		seen[name] = true
		switch name {
		case "host": req.host = value
		case "origin": req.origin = value
		case "authorization": req.authorization = value
		case "transfer-encoding": return {}, 0, false
		case "content-length":
			if value == "" do return {}, 0, false
			for c in value do if c < '0' || c > '9' do return {}, 0, false
			length_ok: bool
			content_length, length_ok = strconv.parse_int(value)
			if !length_ok || content_length < 0 || content_length > 16 << 20 do return {}, 0, false
		}
	}
	return req, content_length, req.host != "" && (req.method != "POST" || seen["content-length"])
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
		if header_end > 16 << 10 || header_end < 0 && len(buf) > 16 << 10 do return {}, false
	}
	// Clone before appending a body: dynamic-buffer growth invalidates slices.
	head := strings.clone(string(buf[:header_end]), context.temp_allocator)
	req, content_length, ok := parse_request_head(head)
	if !ok do return {}, false
	body_start := header_end + 4
	for len(buf) - body_start < content_length {
		n, err := net.recv_tcp(sock, chunk[:min(len(chunk), content_length - (len(buf) - body_start))])
		if err != nil || n == 0 do return {}, false
		append(&buf, ..chunk[:n])
	}
	req.body = buf[body_start:body_start + content_length]
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

HIDDEN_LIST_TYPES :: []string{"program", "typescript", "json", "proto", "relation", "channel", "skill", "peer", "machine", "pinned_fact", "milestone", "agent", VANISH_LOG_TYPE}

handle_list_objects :: proc(sock: net.TCP_Socket) {
	Ctx :: struct {
		sock: net.TCP_Socket,
	}
	ctx := Ctx{sock}
	with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
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
			o := core.jobj()
			o["id"] = json.String(s.id)
			o["typeKey"] = json.String(s.type_key)
			name := ""
			if v, ok := core.fields_get(s.fields, "name"); ok && v.kind == .String do name = v.str
			o["name"] = json.String(name)
			o["updatedAt"] = json.Integer(s.updated_at)
			channel_id := ""
			if v, ok := core.fields_get(s.fields, "channel"); ok && v.kind == .String do channel_id = v.str
			o["channelId"] = json.String(channel_id)
			emoji := ""
			if v, ok := core.fields_get(s.fields, "iconEmoji"); ok && v.kind == .String do emoji = v.str
			o["icon"] = json.String(emoji)
			// Task-layout rows render a live checkbox in lists; ship the state.
			done := false
			if v, ok := core.fields_get(s.fields, "done"); ok && v.kind == .Bool do done = v.b
			o["done"] = json.Boolean(done)
			append(&arr, json.Object(o))
		}
		// Newest first.
		sort_summaries(&arr)
		respond_json(sock, json.Array(arr))
	}, &ctx)
}

sort_summaries :: proc(arr: ^[dynamic]json.Value) {
	// Insertion sort by updatedAt desc (lists are small), id asc as the
	// tiebreak. Without the tiebreak the order among objects sharing a
	// timestamp came from the state map, which iterates differently in every
	// process - so two runs of `list` disagreed and the app's lists reshuffled
	// across reloads for no reason the user did.
	for i in 1 ..< len(arr) {
		j := i
		for j > 0 {
			a, _ := core.json_int(arr[j - 1], "updatedAt")
			b, _ := core.json_int(arr[j], "updatedAt")
			if a != b {
				if a > b do break
			} else {
				if core.json_str(arr[j - 1], "id") <= core.json_str(arr[j], "id") do break
			}
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
	with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
		c := cast(^struct {
			sock: net.TCP_Socket,
			id:   string,
		})user
		s, ok := states[c.id]
		if !ok {
			respond_error(c.sock, "no object", "404 Not Found")
			return
		}
		respond_json(c.sock, core.object_to_json_value(s))
	}, &ctx)
}

handle_relations :: proc(sock: net.TCP_Socket) {
	Ctx :: struct {
		sock: net.TCP_Socket,
	}
	ctx := Ctx{sock}
	with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
		sock := (cast(^struct {
				sock: net.TCP_Socket,
			})user).sock
		arr := make([dynamic]json.Value, context.temp_allocator)
		for _, s in states {
			if s.type_key != "relation" || s.deleted do continue
			o := core.jobj()
			o["id"] = json.String(s.id)
			str := proc(s: ^core.Object_State, k: string) -> string {
				if v, ok := core.fields_get(s.fields, k); ok && v.kind == .String do return v.str
				return ""
			}
			o["key"] = json.String(str(s, "key"))
			o["format"] = json.String(str(s, "format"))
			o["name"] = json.String(str(s, "name"))
			o["iconEmoji"] = json.String(str(s, "iconEmoji"))
			o["space"] = json.String(str(s, "channel"))
			hidden := false
			if v, ok := core.fields_get(s.fields, "hidden"); ok && v.kind == .Bool do hidden = v.b
			o["hidden"] = json.Boolean(hidden)
			read_only := false
			if v, ok := core.fields_get(s.fields, "readOnly"); ok && v.kind == .Bool do read_only = v.b
			o["readOnly"] = json.Boolean(read_only)
			max_count: i64 = 0
			if v, ok := core.fields_get(s.fields, "maxCount"); ok && v.kind == .Int do max_count = v.i
			o["maxCount"] = json.Integer(max_count)
			options := make([dynamic]json.Value, context.temp_allocator)
			if v, ok := core.fields_get(s.fields, "options"); ok && v.kind == .List {
				for item in v.items {
					if item.kind != .Map do continue
					oo := core.jobj()
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
	with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
		sock := (cast(^struct {
				sock: net.TCP_Socket,
			})user).sock
		arr := make([dynamic]json.Value, context.temp_allocator)
		keys := make([dynamic]i64, context.temp_allocator)
		for _, s in states {
			if s.type_key != "channel" || s.deleted do continue
			o := core.jobj()
			o["id"] = json.String(s.id)
			name := ""
			if v, ok := core.fields_get(s.fields, "name"); ok && v.kind == .String do name = v.str
			o["name"] = json.String(name)
		// Anytype precedence: image wins over emoji, else caller falls back
		// to the first letter (their generated-tile equivalent).
		icon := ""
		if v, ok := core.fields_get(s.fields, "iconImage"); ok && v.kind == .String do icon = v.str
		if icon == "" {
			if v, ok := core.fields_get(s.fields, "iconEmoji"); ok && v.kind == .String do icon = v.str
		}
		o["icon"] = json.String(icon)
			pinned := make([dynamic]json.Value, context.temp_allocator)
			if v, ok := core.fields_get(s.fields, "pinnedIds"); ok && v.kind == .List {
				for item in v.items do if item.kind == .String do append(&pinned, json.String(item.str))
			}
			o["pinnedIds"] = json.Array(pinned)
			members := make([dynamic]json.Value, context.temp_allocator)
			if v, ok := core.fields_get(s.fields, "members"); ok && v.kind == .List {
				for item in v.items {
					if item.kind != .Map do continue
					mo := core.jobj()
					for e in item.entries do if e.value.kind == .String do mo[e.key] = json.String(e.value.str)
					append(&members, json.Object(mo))
				}
			}
			o["members"] = json.Array(members)
			key_id: i64 = 0
			if v, ok := core.fields_get(s.fields, "keyId"); ok && v.kind == .Int do key_id = v.i
			o["keyId"] = json.Integer(key_id)
			o["createdAt"] = json.Integer(s.created_at)
			// Display order for the space rail, set by drag-reorder. Absent
			// means "use createdAt", so the two live in one number space and
			// an unordered vault needs no migration. Deliberately does NOT
			// affect the sort below: this payload's order is the protocol's
			// (oldest first), and the UI applies the user's on top.
			if v, ok := core.fields_get(s.fields, "order"); ok {
				if v.kind == .Float do o["order"] = json.Float(v.f)
				else if v.kind == .Int do o["order"] = json.Float(f64(v.i))
			}
			append(&arr, json.Object(o))
			append(&keys, s.created_at)
		}
		// Deterministic order: creation time ascending. The oldest channel
		// is the stable default space that owns unassigned legacy objects -
		// name ordering let any new early-alphabet space steal them.
		for i in 1 ..< len(arr) {
			j := i
			for j > 0 &&
			    (keys[j - 1] > keys[j] ||
					    (keys[j - 1] == keys[j] && strings.compare(core.json_str(arr[j - 1], "id"), core.json_str(arr[j], "id")) > 0)) {
				arr[j - 1], arr[j] = arr[j], arr[j - 1]
				keys[j - 1], keys[j] = keys[j], keys[j - 1]
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
	with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
		c := cast(^struct {
			sock: net.TCP_Socket,
			body: json.Value,
		})user

		// setId: resolve the set's sources into an extra filter.
		extra: json.Value
		set_id := core.json_str(c.body, "setId")
		if set_id != "" {
			if set_obj, ok := states[set_id]; ok {
				extra = core.resolve_set_filter(states, set_obj)
			}
		}

		total := 0
		matched := core.run_query(states, c.body, f64(unix_ms()), extra, context.temp_allocator, &total)
		text := core.json_str(c.body, "textQuery")
		records := make([dynamic]json.Value, context.temp_allocator)
		for s in matched {
			o := core.jobj()
			o["id"] = json.String(s.id)
			o["typeKey"] = json.String(s.type_key)
			name := ""
			if v, ok := core.fields_get(s.fields, "name"); ok && v.kind == .String do name = v.str
			o["name"] = json.String(name)
			o["fields"] = core.fields_to_json(s.fields)
			o["createdAt"] = json.Integer(s.created_at)
			o["updatedAt"] = json.Integer(s.updated_at)
			if s.deleted do o["deleted"] = json.Boolean(true)
			if text != "" {
				snippet := core.text_snippet(s, text)
				if snippet != "" do o["snippet"] = json.String(snippet)
			}
			append(&records, json.Object(o))
		}
		out := core.jobj()
		// The count of everything that matched, not of this page: a client
		// asking for one page needs it to know whether more exist.
		out["total"] = json.Integer(i64(total))
		out["records"] = json.Array(records)
		respond_json(c.sock, json.Object(out))
	}, &ctx)
}

