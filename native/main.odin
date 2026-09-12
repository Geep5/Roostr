package main

// Static-library entry for Swift/C hosts (iOS, macOS). No runtime main runs in
// a library, so the host calls core_init once before any other abi export.

import "base:runtime"
import "../abi"

@(export)
core_init :: proc "c" () {
	context = runtime.default_context()
	#force_no_inline runtime._startup_runtime()
	abi.init()
}
