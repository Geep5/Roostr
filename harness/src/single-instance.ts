/**
 * One copy per computer. Two harnesses would answer every agent twice and
 * two syncs would race on the same `.pb` files, and with the service
 * installed (`bun run service`) a copy started by hand is an easy mistake.
 *
 * The lock is a Unix socket in the data root: the holder listens and tells
 * whoever connects its pid. A socket left behind by a copy that died refuses
 * the connection, so it is cleared and taken over - unlike a pid file, a
 * stale lock can never block a start.
 */

import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function lockPath(name: string): string {
	return join(process.env.GLON_DATA || join(homedir(), ".glon"), `${name}.lock`);
}

/** The pid of the live copy holding `path`, or null when nothing answers. */
function holder(path: string): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	let pid = "";
	Bun.connect({
		unix: path,
		socket: {
			data(_socket, chunk) {
				pid += chunk.toString();
			},
			close() {
				resolve(pid.trim() || "unknown");
			},
			connectError() {
				resolve(null);
			},
		},
	}).catch(() => resolve(null));
	return promise;
}

function listen(path: string): boolean {
	try {
		Bun.listen({
			unix: path,
			socket: {
				open(socket) {
					socket.end(`${process.pid}\n`);
				},
				data() {},
			},
		});
		return true;
	} catch {
		return false;
	}
}

/** Hold this computer's `name` lock for the life of the process, or exit 1 naming the copy that holds it. */
export async function holdSingleInstance(name: string): Promise<void> {
	const path = lockPath(name);
	if (listen(path)) return;
	const pid = await holder(path);
	if (pid !== null) {
		console.error(`[${name}] already running on this computer (pid ${pid}); exiting.`);
		process.exit(1);
	}
	unlinkSync(path);
	if (!listen(path)) {
		console.error(`[${name}] could not take ${path}; exiting.`);
		process.exit(1);
	}
}
