/**
 * The shortcut tool against a fake Shortcut API: the harness signs each
 * request with the agent's Shortcut credential (the Shortcut-Token header),
 * the token never comes back to the tool even when Shortcut echoes it, and
 * an agent without a Shortcut credential gets no request sent at all.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { SHORTCUT_API } from "./shortcut";
import shortcut from "./tool-code/shortcut";
import { harnessFor } from "./tool-harness";
import { createRoostr, harnessCalls, type Roostr } from "./tool-sdk";
import type { ToolContext } from "./tools";

const TOKEN = "sc-token-5f1e2d3c4b5a";
const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-shortcut-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

function object(id: string, typeKey: string, fields: Record<string, ValueJSON>): ObjectJSON {
	return { id, typeKey, fields: { channel: { stringValue: "space" }, ...fields }, blocks: [], deleted: false, createdAt: 0, updatedAt: 0, mailbox: [] };
}

const credential = object("cred", "credential", {
	name: { stringValue: "Shortcut" },
	service: { stringValue: "shortcut" },
	key_api_token: { stringValue: TOKEN },
	status: { stringValue: "active" },
});
const withCredential = object("agent", "agent", { credentials: { valuesValue: { items: [{ linkValue: { relationKey: "credentials", targetId: "cred" } }] } } });
const without = object("agent", "agent", {});

/** The daemon serving `objects`, and Shortcut answering every request with what it was sent (the token included). */
function serve(objects: ObjectJSON[]): Array<{ url: string; method: string; token: string; body: unknown }> {
	const sent: Array<{ url: string; method: string; token: string; body: unknown }> = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.port === "7333" && url.pathname.startsWith("/api/objects/")) {
			const found = objects.find((o) => o.id === url.pathname.slice("/api/objects/".length));
			return Response.json(found ?? {}, { status: found ? 200 : 404 });
		}
		if (url.href.startsWith(SHORTCUT_API)) {
			const token = new Headers(init?.headers).get("Shortcut-Token") ?? "";
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			sent.push({ url: url.href, method: init?.method ?? "GET", token, body });
			if (token !== TOKEN) return new Response("Unauthorized", { status: 401 });
			return Response.json({ id: 42, name: "Pausing", app_url: "https://app.shortcut.com/x/story/42", echoed: token, got: body ?? null });
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
	return sent;
}

const ctx: ToolContext = { agentId: "agent", channelId: "space", depth: 0, touched: new Set<string>() };

function roostr(): Roostr {
	const run = harnessFor(ctx);
	const abort = new AbortController();
	return createRoostr({ agentId: "agent", objectId: "", channelId: "space", machineId: "m" }, new Set(), harnessCalls((method, args) => run(method, args, abort.signal)));
}

test("a request is signed with the credential's token, which never comes back", async () => {
	const sent = serve([withCredential, credential]);
	const read = await shortcut({ path: "/stories/42" }, roostr());
	expect(sent).toEqual([{ url: `${SHORTCUT_API}/stories/42`, method: "GET", token: TOKEN, body: undefined }]);
	expect(read).toContain('"name": "Pausing"');
	expect(read).not.toContain(TOKEN);

	const moved = await shortcut({ path: "/stories/42", method: "put", body: '{"workflow_state_id": 500000008}' }, roostr());
	expect(sent[1]).toEqual({ url: `${SHORTCUT_API}/stories/42`, method: "PUT", token: TOKEN, body: { workflow_state_id: 500000008 } });
	expect(moved).toContain("500000008");
});

test("without a Shortcut credential, or with a bad call, nothing is sent", async () => {
	const sent = serve([without, credential]);
	expect(await shortcut({ path: "/stories/42" }, roostr())).toStartWith("error:");
	serve([withCredential, credential]);
	expect(await shortcut({ path: "stories/42" }, roostr())).toStartWith("error:");
	expect(await shortcut({ path: "/stories", method: "POST" }, roostr())).toStartWith("error:");
	expect(await shortcut({ path: "/stories/42", method: "PATCH" }, roostr())).toStartWith("error:");
	expect(sent).toEqual([]);
});
