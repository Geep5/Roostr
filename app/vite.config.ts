import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
	define: {
		// Dev serves live source, so stamp with server start time - it tells
		// you whether the WINDOW predates the last dev-server restart.
		__BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"),
	},
	plugins: [sveltekit()],
	server: {
		port: 5190,
	},
});
