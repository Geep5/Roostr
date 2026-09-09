package glon

import "core:strings"
import "core:testing"

@(test)
local_auth_contract :: proc(t: ^testing.T) {
	// No filesystem or live daemon: all clocks and credentials are explicit.
	g_local_auth = {}
	defer {
		delete(g_local_auth.code)
		for session in g_local_auth.sessions {
			delete(session.token)
			delete(session.origin)
		}
		g_local_auth = {}
	}
	token := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	g_local_auth.service_token = token
	origin := "https://roostr.example"
	now := i64(100_000)
	testing.expect(t, local_host_valid("127.0.0.1:7333", 7333))
	testing.expect(t, local_host_valid("localhost:7333", 7333))
	testing.expect(t, !local_host_valid("evil.example:7333", 7333))
	testing.expect(t, !local_host_valid("localhost:7334", 7333))
	testing.expect(t, !local_host_valid("localhost:7333.evil.example", 7333))
	testing.expect(t, local_origin_valid(origin))
	testing.expect(t, local_origin_valid("http://localhost:5173"))
	for invalid in ([]string{"null", "", "https://roostr.example/path", "https://x@roostr.example", "http://evil.example", "https://x\r\nX: y"}) {
		testing.expect(t, !local_origin_valid(invalid))
	}
	testing.expect(t, local_role(token, "", now) == .Service)
	testing.expect(t, local_role(token, origin, now) == .None)
	testing.expect(t, local_role("", "", now) == .None)
	testing.expect(t, local_bearer(strings.concatenate({"Bearer ", token}, context.temp_allocator)) == token)
	testing.expect(t, local_bearer(strings.concatenate({"Bearer ", token, ", Bearer ", token}, context.temp_allocator)) == "")

	g_local_auth.code = strings.clone(token)
	g_local_auth.code_expires = now + LOCAL_PAIR_TTL
	for i in 0..<5 {
		_, _, status := local_pair("wrong", origin, now)
		testing.expect(t, status == "401 Unauthorized")
	}
	_, _, blocked := local_pair(token, origin, now)
	testing.expect(t, blocked == "429 Too Many Requests")
	paired, expires, status := local_pair(token, origin, now + 60_000)
	testing.expect(t, status == "200 OK" && len(paired) == 64)
	testing.expect(t, local_role(paired, origin, now + 60_001) == .UI)
	testing.expect(t, local_role(paired, "https://evil.example", now + 60_001) == .None)
	testing.expect(t, local_role(paired, "", now + 60_001) == .None)
	testing.expect(t, local_role(paired, origin, expires) == .None)
	testing.expect(t, local_origin_paired(origin, expires-1))
	testing.expect(t, !local_origin_paired(origin, expires))
	_, _, reused := local_pair(token, origin, now + 60_002)
	testing.expect(t, reused == "401 Unauthorized")
	g_local_auth.code = strings.clone(token)
	g_local_auth.code_expires = now + 60_003
	_, _, expired := local_pair(token, origin, now + 60_003)
	testing.expect(t, expired == "401 Unauthorized")
	for i in 1..<64 {
		delete(g_local_auth.code)
		g_local_auth.code = strings.clone(token)
		at := now + 120_000 + i64(i)*60_000
		g_local_auth.code_expires = at + LOCAL_PAIR_TTL
		_, _, filled := local_pair(token, origin, at)
		testing.expect(t, filled == "200 OK")
	}
	g_local_auth.code = strings.clone(token)
	g_local_auth.code_expires = now + 10_000_000
	_, _, full := local_pair(token, origin, now + 4_000_000)
	testing.expect(t, full == "429 Too Many Requests")
}

@(test)
local_http_header_contract :: proc(t: ^testing.T) {
	request, length, ok := parse_request_head("POST /api/mutate?token=ignored HTTP/1.1\r\nHoSt: localhost:7333\r\nContent-Length: 2\r\nOrigin: https://roostr.example\r\nAuthorization: Bearer abc")
	testing.expect(t, ok && length == 2 && request.path == "/api/mutate")
	testing.expect(t, request.host == "localhost:7333" && request.origin == "https://roostr.example" && request.authorization == "Bearer abc")
	for invalid in ([]string{
		"GET /api/events HTTP/1.1",
		"GET /api/events HTTP/1.1\r\nHost: localhost:7333\r\nhost: evil.example",
		"GET /api/events HTTP/1.1\r\nHost: localhost:7333\r\nOrigin: https://one.example\r\norigin: https://two.example",
		"GET /api/events HTTP/1.1\r\nHost: localhost:7333\r\nAuthorization: Bearer x\r\nauthorization: Bearer y",
		"POST /api/mutate HTTP/1.1\r\nHost: localhost:7333\r\nContent-Length: -1",
		"POST /api/mutate HTTP/1.1\r\nHost: localhost:7333\r\nContent-Length: 99999999999999999999999",
		"POST /api/mutate HTTP/1.1\r\nHost: localhost:7333\r\nContent-Length: 1\r\nContent-Length: 2",
		"POST /api/mutate HTTP/1.1\r\nHost: localhost:7333\r\nTransfer-Encoding: chunked",
		"GET http://localhost:7333/api/events HTTP/1.1\r\nHost: localhost:7333",
		"GET /api/events HTTP/1.1\r\nHost : localhost:7333",
		"GET /api/events HTTP/1.1\r\nHost: localhost:7333\r\n Authorization: Bearer x",
	}) {
		_, _, valid := parse_request_head(invalid)
		testing.expect(t, !valid)
	}
}
