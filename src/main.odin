package glon

// glon-odin — the glon notes substrate on Odin.
//
//   glon-odin serve [port]     HTTP API + SSE (default 7333)
//   glon-odin list             object summaries from the DAG
//   glon-odin dump <objectId>  computed state as JSON (parity testing)

import "core:os"
import "core:fmt"
import "core:strconv"
import "core:path/filepath"

main :: proc() {
	data_root := os.get_env_alloc("GLON_DATA", context.allocator)
	if data_root == "" {
		home := os.get_env_alloc("HOME", context.allocator)
		data_root, _ = filepath.join({home, ".glon"})
	}
	store_init(data_root)

	args := os.args
	cmd := len(args) > 1 ? args[1] : "serve"

	switch cmd {
	case "list":
		cli_list()
	case "dump":
		if len(args) < 3 {
			fmt.eprintln("usage: glon-odin dump <objectId>")
			os.exit(1)
		}
		cli_dump(args[2])
	case "serve":
		port := 7333
		if len(args) > 2 {
			if p, ok := strconv.parse_int(args[2]); ok do port = p
		}
		bootstrap_relations()
		serve(port)
	case:
		fmt.eprintln("usage: glon-odin [serve [port] | list | dump <objectId>]")
		os.exit(1)
	}
}

cli_list :: proc() {
	with_states(proc(states: map[string]^Object_State, _: rawptr) {
		for id, s in states {
			name := ""
			if v, ok := fields_get(s.fields, "name"); ok && v.kind == .String do name = v.str
			fmt.printfln("%-38s %-12s %-24s blocks=%d deleted=%v", id, s.type_key, name, len(s.blocks), s.deleted)
		}
	})
}

cli_dump :: proc(object_id: string) {
	ctx := struct {
		id: string,
	}{object_id}
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
		id := (cast(^struct {
				id: string,
			})user).id
		s, ok := states[id]
		if !ok {
			fmt.eprintln("no object", id)
			return
		}
		fmt.println(string(object_to_json(s, context.temp_allocator)))
	}, &ctx)
}
