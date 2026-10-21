package glon

// This daemon's device record (core/device.odin): it holds the whole vault,
// so it is always "full", 100%, kind "engine", named after the machine. It
// runs as long as the computer does, so it keeps last_seen current itself.

import "../core"
import "core:encoding/json"
import "core:fmt"
import "core:os"
import "core:strings"
import "core:sync"
import "core:sys/posix"
import "core:time"

// How often the record is checked; the planner writes only what changed and
// last_seen once core.DEVICE_SEEN_MS has passed.
DEVICE_CHECK_INTERVAL :: 5 * time.Minute

g_device_name: string

/** The record's id: `__device__:` and this install's device id. */
device_record_id :: proc() -> string {
	return strings.concatenate({core.DEVICE_ID_PREFIX, device_id()}, context.temp_allocator)
}

/**
 * The machine's name as a person knows it: macOS's Computer Name ("Grant's
 * MacBook Pro"), else the host name without its `.local` suffix.
 */
machine_name :: proc() -> string {
	when ODIN_OS == .Darwin {
		state, out, _, err := os.process_exec(os.Process_Desc{command = {"/usr/sbin/scutil", "--get", "ComputerName"}}, context.temp_allocator)
		if err == nil && state.exit_code == 0 {
			if name := strings.trim_space(string(out)); name != "" do return strings.clone(name)
		}
	}
	raw := ""
	when ODIN_OS == .Windows {
		raw = os.get_env_alloc("COMPUTERNAME", context.temp_allocator)
	} else {
		buf: [256]u8
		if posix.gethostname(raw_data(buf[:]), len(buf)) == .OK do raw = strings.clone_from_cstring(cstring(raw_data(buf[:])), context.temp_allocator)
	}
	return strings.clone(host_label(raw))
}

/** A host name as a label: trimmed, `.local` dropped, "This computer" when there is none. */
host_label :: proc(raw: string) -> string {
	name := strings.trim_space(raw)
	name = strings.trim_suffix(name, ".local")
	return name == "" ? "This computer" : name
}

/** Plan and commit this daemon's record; nothing when nothing is due. */
device_record_write :: proc() {
	sync.lock(&g_mutation_mu)
	defer sync.unlock(&g_mutation_mu)
	params := core.jobj()
	params["action"] = json.String("device_seen")
	params["object_id"] = json.String(device_record_id())
	params["name"] = json.String(g_device_name)
	params["kind"] = json.String("engine")
	params["holding"] = json.String("full")
	params["percent"] = json.Integer(100)
	plan, err := native_mutation_plan(json.Object(params))
	if err != "" || !native_commit_plan(&plan) do fmt.eprintfln("[glon-odin] device record write failed: %s", err)
}

device_record_loop :: proc() {
	for {
		device_record_write()
		free_all(context.temp_allocator)
		time.sleep(DEVICE_CHECK_INTERVAL)
	}
}
