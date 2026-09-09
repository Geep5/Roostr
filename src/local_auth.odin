package glon

import "core:crypto"
import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"
import "core:net"
import "core:os"
import "core:path/filepath"
import "core:strconv"
import "core:strings"
import "core:sync"
import "../core"
Local_Role :: enum { None, Service, UI }
Local_Session :: struct { token, origin: string, expires: i64 }
Local_Auth :: struct {
	mu: sync.Mutex,
	service_token: string,
	port: int,
	code: string,
	code_expires, attempt_window: i64,
	attempts: int,
	sessions: [64]Local_Session,
}
g_local_auth: Local_Auth
@(thread_local) g_response_cors: string
@(thread_local) g_session_expires: i64
LOCAL_PAIR_TTL :: i64(5 * 60 * 1000)
LOCAL_SESSION_TTL :: i64(24 * 60 * 60 * 1000)

local_random_token :: proc() -> string {
	bytes: [32]byte
	crypto.rand_bytes(bytes[:])
	return string(hex.encode(bytes[:], context.allocator))
}

local_secret_equal :: proc(a, b: string) -> bool {
	if len(a) != len(b) || len(a) == 0 do return false
	diff: u8
	for i in 0..<len(a) do diff |= a[i] ~ b[i]
	return diff == 0
}

local_auth_init :: proc(port: int) {
	g_local_auth.port = port
	path, _ := filepath.join({g_store.data_root, "api-token"}, context.temp_allocator)
	file, err := os.open(path)
	if err != nil {
		file, err = os.open(path, {.Write, .Create, .Excl}, {.Read_User, .Write_User})
		if err != nil do panic("cannot securely create api-token")
		token := local_random_token()
		n, werr := os.write_string(file, token)
		os.close(file)
		if werr != nil || n != len(token) do panic("cannot write api-token")
		g_local_auth.service_token = token
	} else {
		defer os.close(file)
		if os.fchmod(file, {.Read_User, .Write_User}) != nil do panic("cannot secure api-token")
		data, rerr := os.read_entire_file(file, context.temp_allocator)
		if rerr != nil do panic("cannot read api-token")
		token := strings.trim_space(string(data))
		if len(token) != 64 do panic("invalid api-token")
		for c in token do if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') do panic("invalid api-token")
		g_local_auth.service_token = strings.clone(token)
	}
	local_pair_start()
}

// Only a local service/operator may rotate the code. HTTP never returns it.
local_pair_start :: proc() {
	sync.lock(&g_local_auth.mu)
	defer sync.unlock(&g_local_auth.mu)
	// code is "" (string literal) after a successful pair consumed it; only heap codes may be deleted.
	if g_local_auth.code != "" do delete(g_local_auth.code)
	g_local_auth.code = local_random_token()
	g_local_auth.code_expires = unix_ms() + LOCAL_PAIR_TTL
	fmt.eprintfln("[glon-odin] Browser pairing code (one use, 5 minutes): %s", g_local_auth.code)
}

local_host_valid :: proc(host: string, port: int) -> bool {
	return host == fmt.tprintf("127.0.0.1:%d", port) || host == fmt.tprintf("localhost:%d", port) || host == fmt.tprintf("[::1]:%d", port)
}

// Accept serialized browser origins only, never null, credentials or URL paths.
local_origin_valid :: proc(origin: string) -> bool {
	if len(origin) == 0 || len(origin) > 512 do return false
	https := strings.has_prefix(origin, "https://")
	if !https && !strings.has_prefix(origin, "http://") do return false
	authority := origin[(https ? 8 : 7):]
	if authority == "" do return false
	for c in authority do if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '-' || c == ':') do return false
	host := authority
	if colon := strings.index_byte(authority, ':'); colon >= 0 {
		host = authority[:colon]
		port, ok := strconv.parse_int(authority[colon+1:])
		if !ok || port < 1 || port > 65535 do return false
	}
	if host == "" do return false
	return https || host == "localhost" || host == "127.0.0.1"
}

local_cors :: proc(origin: string) -> string {
	if origin == "" do return ""
	return fmt.tprintf("Access-Control-Allow-Origin: %s\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\n", origin)
}

local_bearer :: proc(header: string) -> string {
	if !strings.has_prefix(header, "Bearer ") do return ""
	token := header[7:]
	if len(token) != 64 do return ""
	for c in token do if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') do return ""
	return token
}

// Identity and relay configuration are deliberately platform-only; a paired
// browser session (.UI) must never reach these four mutate actions.
local_platform_action :: proc(action: string) -> bool {
	switch action {
	case "nostr_key_export", "nostr_key_import", "identity_logout", "nostr_relays_set": return true
	}
	return false
}

local_role :: proc(token, origin: string, now: i64) -> Local_Role {
	sync.lock(&g_local_auth.mu)
	defer sync.unlock(&g_local_auth.mu)
	if origin == "" && local_secret_equal(token, g_local_auth.service_token) { g_session_expires = max(i64); return .Service }
	if !local_origin_valid(origin) do return .None
	for session in g_local_auth.sessions {
		if session.expires > now && session.origin == origin && local_secret_equal(token, session.token) { g_session_expires = session.expires; return .UI }
	}
	return .None
}

local_origin_paired :: proc(origin: string, now: i64) -> bool {
	if !local_origin_valid(origin) do return false
	sync.lock(&g_local_auth.mu)
	defer sync.unlock(&g_local_auth.mu)
	for session in g_local_auth.sessions do if session.expires > now && session.origin == origin do return true
	return false
}

local_pair :: proc(code, origin: string, now: i64) -> (token: string, expires: i64, status: string) {
	sync.lock(&g_local_auth.mu)
	defer sync.unlock(&g_local_auth.mu)
	if !local_origin_valid(origin) do return "", 0, "403 Forbidden"
	if now - g_local_auth.attempt_window >= 60_000 {
		g_local_auth.attempt_window = now
		g_local_auth.attempts = 0
	}
	if g_local_auth.attempts >= 5 do return "", 0, "429 Too Many Requests"
	g_local_auth.attempts += 1
	if now >= g_local_auth.code_expires || !local_secret_equal(code, g_local_auth.code) do return "", 0, "401 Unauthorized"
	for &session in g_local_auth.sessions {
		if session.expires > now do continue
		delete(session.token)
		delete(session.origin)
		session = Local_Session{local_random_token(), strings.clone(origin), now + LOCAL_SESSION_TTL}
		g_local_auth.code_expires = 0
		delete(g_local_auth.code)
		g_local_auth.code = ""
		return session.token, session.expires, "200 OK"
	}
	return "", 0, "429 Too Many Requests"
}

// Runs before every route (including SSE), and before any secret/store access.
local_authorize :: proc(sock: net.TCP_Socket, req: Request) -> bool {
	g_response_cors = ""
	if !local_host_valid(req.host, g_local_auth.port) {
		respond_error(sock, "invalid Host", "403 Forbidden")
		return false
	}
	now := unix_ms()
	pair := req.path == "/api/pair"
	if req.method == "OPTIONS" {
		if !local_origin_valid(req.origin) || (!pair && req.path != "/api/pair/status" && !local_origin_paired(req.origin, now)) {
			respond_error(sock, "origin not paired", "403 Forbidden")
		} else {
			g_response_cors = local_cors(req.origin)
			respond(sock, "204 No Content", "text/plain", {})
		}
		return false
	}
	if req.method == "GET" && req.path == "/api/pair/status" {
		if local_origin_valid(req.origin) do g_response_cors = local_cors(req.origin)
		respond(sock, "200 OK", "application/json", transmute([]byte)string("{\"needsPair\":true}"))
		return false
	}
	if req.method == "POST" && pair {
		if local_origin_valid(req.origin) do g_response_cors = local_cors(req.origin)
		if !core.json_depth_ok(req.body) { respond_error(sock, "invalid JSON"); return false }
		parsed, err := json.parse(req.body, allocator = context.temp_allocator)
		if err != nil { respond_error(sock, "invalid JSON"); return false }
		token, expires, status := local_pair(core.json_str(parsed, "code"), req.origin, now)
		if token == "" { respond_error(sock, "pairing rejected", status); return false }
		o := core.jobj()
		o["token"] = json.String(token)
		o["expiresAt"] = json.Float(f64(expires))
		o["role"] = json.String("ui")
		respond_json(sock, json.Object(o))
		return false
	}
	role := local_role(local_bearer(req.authorization), req.origin, now)
	if role == .None { respond_error(sock, "authentication required", "401 Unauthorized"); return false }
	if role == .UI do g_response_cors = local_cors(req.origin)
	if req.path == "/api/local-auth/validate" {
		if role != .Service || req.method != "POST" { respond_error(sock, "service only", "403 Forbidden"); return false }
		if !core.json_depth_ok(req.body) { respond_error(sock, "invalid JSON"); return false }
		parsed, err := json.parse(req.body, allocator = context.temp_allocator)
		if err != nil { respond_error(sock, "invalid JSON"); return false }
		validated := local_role(core.json_str(parsed, "token"), core.json_str(parsed, "origin"), now)
		o := core.jobj()
		o["ok"] = json.Boolean(validated != .None)
		o["role"] = json.String(validated == .UI ? "ui" : validated == .Service ? "service" : "none")
		respond_json(sock, json.Object(o))
		return false
	}
	if req.path == "/api/pair/start" {
		if role != .Service || req.method != "POST" { respond_error(sock, "service only", "403 Forbidden"); return false }
		local_pair_start()
		respond(sock, "200 OK", "application/json", transmute([]byte)string("{\"ok\":true}"))
		return false
	}
	if role == .UI {
		if req.method == "POST" && req.path == "/api/changes" { respond_error(sock, "service only", "403 Forbidden"); return false }
		if req.method == "POST" && req.path == "/api/mutate" {
			if !core.json_depth_ok(req.body) { respond_error(sock, "invalid JSON"); return false }
			parsed, err := json.parse(req.body, allocator = context.temp_allocator)
			if err != nil { respond_error(sock, "invalid JSON"); return false }
			if local_platform_action(core.json_str(parsed, "action")) { respond_error(sock, "action requires local operator", "403 Forbidden"); return false }
		}
	}
	return true
}
