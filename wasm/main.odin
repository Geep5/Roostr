package main

// Browser WASM entry: the js_wasm32 runtime calls main from _start, which is
// where the shared abi package initialises its request arena.

import "../abi"

main :: proc() {
	abi.init()
}
