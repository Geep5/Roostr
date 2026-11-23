package glon

// Roostr Pass's link to this computer (harness/src/pass.ts, roostr-pass/).
//
// Chrome starts `glon-odin` as the extension's native messaging host: the
// manifest `glon-odin pass install <extension-id>` writes names this binary,
// and Chrome passes the extension's origin (chrome-extension://<id>/) as the
// first argument, which is how main() tells this mode apart. Messages are
// Chrome's framing - a 4-byte native-endian length, then JSON - both ways:
//
//   {"type":"watch"}                          → the harness's GET /pass/watch
//   {"type":"cookies","id":…,"cookies":[…]}   → its POST /pass/cookies
//
// Each answer is the harness's JSON, or {"error": …}. The host authenticates
// with this computer's service token (<GLON_DATA>/api-token), so only an
// extension Chrome lets start it - the one the manifest allows - can reach
// the two Roostr Pass routes; it never opens the store.

import "core:encoding/json"
import "core:fmt"
import "core:net"
import "core:os"
import "core:path/filepath"
import "core:strconv"
import "core:strings"
import "../core"

PASS_HOST_NAME :: "space.roostr.pass"
// Chrome's limit on a message to the extension.
PASS_REPLY_MAX :: 1 << 20
// A message from the extension: one site's cookies, with room to spare.
PASS_MESSAGE_MAX :: 4 << 20

pass_data_root :: proc() -> string {
	root := os.get_env_alloc("GLON_DATA", context.temp_allocator)
	if root != "" do return root
	home := os.get_env_alloc("HOME", context.temp_allocator)
	out, _ := filepath.join({home, ".glon"}, context.temp_allocator)
	return out
}

pass_service_token :: proc() -> (string, bool) {
	path, _ := filepath.join({pass_data_root(), "api-token"}, context.temp_allocator)
	data, err := os.read_entire_file(path, context.temp_allocator)
	if err != nil do return "", false
	token := strings.trim_space(string(data))
	if len(token) != 64 do return "", false
	return token, true
}

pass_harness_port :: proc() -> int {
	if p, ok := strconv.parse_int(os.get_env_alloc("GLON_AUTH_PORT", context.temp_allocator)); ok && p > 0 && p < 65536 do return p
	return 7334
}

/* One request to the harness on this computer; the body of a 200, else why not. */
pass_harness_call :: proc(method, path: string, body: []byte) -> (reply: []byte, err: string) {
	token, have := pass_service_token()
	if !have do return nil, "Roostr is not set up on this computer (no api-token)"
	port := pass_harness_port()
	sock, derr := net.dial_tcp(net.Endpoint{net.IP4_Loopback, port})
	if derr != nil do return nil, "Roostr isn't running on this computer"
	defer net.close(sock)
	head := fmt.tprintf("%s %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", method, path, port, token, len(body))
	if !send_all(sock, transmute([]byte)head) || len(body) > 0 && !send_all(sock, body) do return nil, "the harness closed the connection"
	// Bun keeps the connection open whatever the request says: the answer ends at its
	// Content-Length (or its last chunk), not at EOF.
	buf := make([dynamic]byte, context.temp_allocator)
	chunk: [8192]byte
	split := -1
	length := -1
	chunked := false
	for {
		n, rerr := net.recv_tcp(sock, chunk[:])
		if rerr != nil || n == 0 do break
		append(&buf, ..chunk[:n])
		if len(buf) > PASS_REPLY_MAX + 16 << 10 do return nil, "the harness's answer is too large"
		if split < 0 {
			split = strings.index(string(buf[:]), "\r\n\r\n")
			if split < 0 do continue
			for line in strings.split(strings.to_lower(string(buf[:split]), context.temp_allocator), "\r\n", context.temp_allocator) {
				if strings.has_prefix(line, "content-length:") {
					if v, ok := strconv.parse_int(strings.trim_space(line[len("content-length:"):])); ok do length = v
				}
				if strings.has_prefix(line, "transfer-encoding:") && strings.contains(line, "chunked") do chunked = true
			}
		}
		if length >= 0 && len(buf) - (split + 4) >= length do break
		if chunked && strings.has_suffix(string(buf[:]), "\r\n0\r\n\r\n") do break
	}
	if split < 0 do return nil, "no answer from the harness"
	text := string(buf[:])
	status_line := text[:strings.index(text, "\r\n")]
	parts := strings.split(status_line, " ", context.temp_allocator)
	code := len(parts) > 1 ? parts[1] : ""
	payload := buf[split + 4:]
	if length >= 0 && len(payload) > length do payload = payload[:length]
	if chunked do payload = pass_unchunk(payload)
	if code != "200" {
		parsed, perr := json.parse(payload, allocator = context.temp_allocator)
		if perr == nil {
			if msg := core.json_str(parsed, "error"); msg != "" do return nil, msg
		}
		return nil, fmt.tprintf("the harness answered %s", code)
	}
	return payload, ""
}

/* A chunked body, joined. */
pass_unchunk :: proc(body: []byte) -> []byte {
	out := make([dynamic]byte, context.temp_allocator)
	rest := string(body)
	for {
		line_end := strings.index(rest, "\r\n")
		if line_end < 0 do break
		size, ok := strconv.parse_int(strings.trim_space(rest[:line_end]), 16)
		if !ok || size <= 0 do break
		start := line_end + 2
		if start + size > len(rest) do break
		append(&out, ..transmute([]byte)rest[start:start + size])
		rest = rest[start + size:]
		if strings.has_prefix(rest, "\r\n") do rest = rest[2:]
	}
	return out[:]
}

pass_error :: proc(msg: string) -> []byte {
	o := make(json.Object, context.temp_allocator)
	o["error"] = json.String(msg)
	return core.marshal(o)
}

/* The answer to one message from the extension. */
pass_answer :: proc(message: []byte) -> []byte {
	parsed, perr := json.parse(message, allocator = context.temp_allocator)
	if perr != nil do return pass_error("not JSON")
	switch core.json_str(parsed, "type") {
	case "watch":
		reply, err := pass_harness_call("GET", "/pass/watch", nil)
		return err != "" ? pass_error(err) : reply
	case "cookies":
		obj, is_obj := parsed.(json.Object)
		cookies, has := obj["cookies"]
		if !is_obj || !has do return pass_error("cookies are required")
		body := make(json.Object, context.temp_allocator)
		body["id"] = json.String(core.json_str(parsed, "id"))
		body["cookies"] = cookies
		reply, err := pass_harness_call("POST", "/pass/cookies", core.marshal(body))
		return err != "" ? pass_error(err) : reply
	}
	return pass_error("unknown message")
}

pass_read_exact :: proc(buf: []byte) -> bool {
	got := 0
	for got < len(buf) {
		n, err := os.read(os.stdin, buf[got:])
		if err != nil || n <= 0 do return false
		got += n
	}
	return true
}

pass_write :: proc(reply: []byte) -> bool {
	out := reply
	if len(out) > PASS_REPLY_MAX do out = pass_error("the answer is too large for Chrome")
	size := u32(len(out))
	head := transmute([4]byte)size
	if _, err := os.write(os.stdout, head[:]); err != nil do return false
	_, err := os.write(os.stdout, out)
	return err == nil
}

/* Chrome's native host: answer messages until Chrome closes the pipe. */
pass_host :: proc() {
	for {
		head: [4]byte
		if !pass_read_exact(head[:]) do return
		size := int(transmute(u32)head)
		if size <= 0 || size > PASS_MESSAGE_MAX do return
		message := make([]byte, size, context.temp_allocator)
		if !pass_read_exact(message) do return
		if !pass_write(pass_answer(message)) do return
		free_all(context.temp_allocator)
	}
}

/* Where each Chromium browser present on this computer looks for native hosts. */
pass_manifest_dirs :: proc() -> [dynamic]string {
	home := os.get_env_alloc("HOME", context.temp_allocator)
	out := make([dynamic]string, context.temp_allocator)
	when ODIN_OS == .Darwin {
		browsers := []string{"Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge", "Arc/User Data"}
		for b in browsers {
			dir, _ := filepath.join({home, "Library/Application Support", b}, context.temp_allocator)
			if os.exists(dir) {
				hosts, _ := filepath.join({dir, "NativeMessagingHosts"}, context.temp_allocator)
				append(&out, hosts)
			}
		}
	} else {
		browsers := []string{"google-chrome", "google-chrome-beta", "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge"}
		for b in browsers {
			dir, _ := filepath.join({home, ".config", b}, context.temp_allocator)
			if os.exists(dir) {
				hosts, _ := filepath.join({dir, "NativeMessagingHosts"}, context.temp_allocator)
				append(&out, hosts)
			}
		}
	}
	return out
}

/* Chrome extension ids are 32 letters a-p. */
pass_extension_id_valid :: proc(id: string) -> bool {
	if len(id) != 32 do return false
	for c in id do if c < 'a' || c > 'p' do return false
	return true
}

/* `glon-odin pass install <extension-id>`: register this binary as Roostr Pass's native host. */
pass_cli :: proc(args: []string) {
	if len(args) != 2 || args[0] != "install" || !pass_extension_id_valid(args[1]) {
		fmt.eprintln("usage: glon-odin pass install <extension-id>   (the 32-letter id chrome://extensions shows for Roostr Pass)")
		os.exit(1)
	}
	exe, aerr := filepath.abs(os.args[0], context.temp_allocator)
	if aerr != nil {
		fmt.eprintln("cannot resolve this binary's path")
		os.exit(1)
	}
	manifest := make(json.Object, context.temp_allocator)
	manifest["name"] = json.String(PASS_HOST_NAME)
	manifest["description"] = json.String("Roostr Pass: browser sign-ins from Chrome for Roostr")
	manifest["path"] = json.String(exe)
	manifest["type"] = json.String("stdio")
	origins := make(json.Array, 0, 1, context.temp_allocator)
	append(&origins, json.String(fmt.tprintf("chrome-extension://%s/", args[1])))
	manifest["allowed_origins"] = origins
	text := core.marshal(manifest)
	dirs := pass_manifest_dirs()
	if len(dirs) == 0 {
		fmt.eprintln("no Chrome, Chromium, Brave, Edge or Arc profile found on this computer")
		os.exit(1)
	}
	for dir in dirs {
		os.make_directory(dir)
		path, _ := filepath.join({dir, PASS_HOST_NAME + ".json"}, context.temp_allocator)
		if err := os.write_entire_file(path, text); err != nil {
			fmt.eprintfln("could not write %s: %v", path, err)
			os.exit(1)
		}
		fmt.println("wrote", path)
	}
	fmt.println("Roostr Pass can reach this computer's Roostr now: reload the extension in chrome://extensions.")
}
