import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShippedCommand } from "./shipped-commands";

// Shipped commands (gws-as, roostr-design) land on PATH as links into this
// checkout, so a pull updates them - and never over a file someone wrote.
let root = "";
let bin = "";
let shipped = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "shipped-"));
	bin = join(root, "bin");
	shipped = join(root, "roostr-design");
	writeFileSync(shipped, "#!/bin/sh\necho shipped\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a missing command is linked to this checkout's copy", () => {
	expect(installShippedCommand("roostr-design", bin, shipped)).toBe(true);
	expect(readlinkSync(join(bin, "roostr-design"))).toBe(shipped);
});

test("a link left dangling by a moved checkout is re-pointed", () => {
	mkdirSync(bin);
	symlinkSync(join(root, "old-checkout", "roostr-design"), join(bin, "roostr-design"));
	expect(installShippedCommand("roostr-design", bin, shipped)).toBe(true);
	expect(readlinkSync(join(bin, "roostr-design"))).toBe(shipped);
});

test("a legacy copy an older harness wrote is replaced, someone's own file is not", () => {
	const gws = join(root, "gws-as");
	writeFileSync(gws, "#!/bin/bash\n# Run gws as one explicitly named Google account.\n");
	mkdirSync(bin);
	writeFileSync(join(bin, "gws-as"), "#!/bin/bash\n# Run gws against one explicitly selected Google account.\nold\n");
	expect(installShippedCommand("gws-as", bin, gws)).toBe(true);
	expect(lstatSync(join(bin, "gws-as")).isSymbolicLink()).toBe(true);

	writeFileSync(join(bin, "roostr-design"), "#!/bin/sh\necho mine\n");
	expect(installShippedCommand("roostr-design", bin, shipped)).toBe(false);
	expect(readFileSync(join(bin, "roostr-design"), "utf8")).toBe("#!/bin/sh\necho mine\n");
});
