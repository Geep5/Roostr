/**
 * Roostr as an OS service: the store, sync and harness (and, with --web, a
 * local web app) start at boot and come back when one crashes; a crash
 * shows as the Error on this computer's Computer object (supervisor.ts).
 *
 *   bun run service install [--web <path>]   write the service, start it now and at every boot
 *   bun run service uninstall                stop it and remove the service
 *   bun run service restart                  restart everything (after a pull or a rebuild)
 *   bun run service logs                     follow every program's output
 *   bun run service run [--web <path>]       the supervisor itself: what the service runs
 *
 * Linux: a systemd user unit (`roostr.service`), started at boot by
 * lingering. macOS: a LaunchAgent (`app.roostr`), started at login - a Mac
 * with FileVault runs nothing before someone logs in anyway.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { API, bv, flag, setField } from "./api";
import { AUTOSTART_KEY, ownMachine } from "./machine";
import { supervise, type Program } from "./supervisor";

const HARNESS_DIR = resolve(import.meta.dir, "..");
const REPO_DIR = resolve(HARNESS_DIR, "..");
const DAEMON = join(REPO_DIR, "glon-odin");
const STORE_PORT = Number(new URL(API).port || 7333);
/** Picked up at install when set: the data root, API and harness port every program must agree on. */
const PASSED_ENV = ["GLON_DATA", "GLON_API", "GLON_AUTH_PORT"];

const UNIT = "roostr.service";
const UNIT_PATH = join(homedir(), ".config/systemd/user", UNIT);
const LABEL = "app.roostr";
const PLIST_PATH = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const MAC_LOG = join(homedir(), "Library/Logs/Roostr/roostr.log");
/** The two hand-installed LaunchAgents this service replaces. */
const LEGACY_LABELS = ["app.roostr.daemon", "app.roostr.harness"];

const OS = platform();
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;

function argValue(name: string): string {
	const idx = process.argv.indexOf(name);
	return idx >= 0 ? (process.argv[idx + 1] ?? "") : "";
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

/** Run a command with its output shown; false when it fails. */
function sh(cmd: string[]): boolean {
	return Bun.spawnSync({ cmd, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
}

/** Run a command quietly: its output, or null when it fails. */
function capture(cmd: string[]): string | null {
	const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

async function storeAnswers(): Promise<boolean> {
	try {
		(await Bun.connect({ hostname: "127.0.0.1", port: STORE_PORT, socket: { data() {} } })).end();
		return true;
	} catch {
		return false;
	}
}

function programs(web: string): Program[] {
	const bun = process.execPath;
	const list: Program[] = [
		{ name: "store", label: "Store", cmd: [DAEMON, "serve", String(STORE_PORT)], cwd: REPO_DIR },
		{ name: "sync", label: "Sync", cmd: [bun, "run", "src/sync.ts"], cwd: HARNESS_DIR },
		{ name: "harness", label: "Harness", cmd: [bun, "run", "src/index.ts", "serve"], cwd: HARNESS_DIR },
	];
	if (web) list.push({ name: "web", label: "Web app", cmd: ["npm", "run", "dev:local"], cwd: web });
	return list;
}

// ── Service files ────────────────────────────────────────────────

function systemdUnit(args: string[], env: Record<string, string>): string {
	// Unit files expand %-specifiers and split on unquoted spaces.
	const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
	return [
		"[Unit]",
		"Description=Roostr: store, sync and harness (bun run service)",
		// Never give up restarting: the supervisor paces its own programs.
		"StartLimitIntervalSec=0",
		"",
		"[Service]",
		`WorkingDirectory=${HARNESS_DIR.replace(/%/g, "%%")}`,
		`ExecStart=${args.map(q).join(" ")}`,
		...Object.entries(env).map(([key, value]) => `Environment=${q(`${key}=${value}`)}`),
		"Restart=always",
		"RestartSec=5",
		// SIGTERM to the supervisor only: it stops its programs in order.
		"KillMode=mixed",
		"TimeoutStopSec=20",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

function launchdPlist(args: string[], env: Record<string, string>): string {
	const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		`\t<key>Label</key>\n\t<string>${LABEL}</string>`,
		`\t<key>WorkingDirectory</key>\n\t<string>${x(HARNESS_DIR)}</string>`,
		`\t<key>ProgramArguments</key>\n\t<array>\n${args.map((a) => `\t\t<string>${x(a)}</string>`).join("\n")}\n\t</array>`,
		`\t<key>EnvironmentVariables</key>\n\t<dict>\n${Object.entries(env).map(([k, v]) => `\t\t<key>${x(k)}</key>\n\t\t<string>${x(v)}</string>`).join("\n")}\n\t</dict>`,
		"\t<key>RunAtLoad</key>\n\t<true/>",
		"\t<key>KeepAlive</key>\n\t<true/>",
		"\t<key>ThrottleInterval</key>\n\t<integer>5</integer>",
		"\t<key>ExitTimeOut</key>\n\t<integer>20</integer>",
		`\t<key>StandardOutPath</key>\n\t<string>${x(MAC_LOG)}</string>`,
		`\t<key>StandardErrorPath</key>\n\t<string>${x(MAC_LOG)}</string>`,
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

// ── Per-OS operations ────────────────────────────────────────────

const systemd = {
	active: () => capture(["systemctl", "--user", "is-active", UNIT]) === "active",
	start: () => sh(["systemctl", "--user", "start", UNIT]),
	restart: () => sh(["systemctl", "--user", "restart", UNIT]),
};

const launchd = {
	active: () => capture(["launchctl", "print", `${DOMAIN}/${LABEL}`]) !== null,
	start: () => sh(["launchctl", "bootstrap", DOMAIN, PLIST_PATH]),
	restart: () => (launchd.active() ? sh(["launchctl", "kickstart", "-k", `${DOMAIN}/${LABEL}`]) : launchd.start()),
};

function service(): typeof systemd {
	if (OS === "linux") return systemd;
	if (OS === "darwin") return launchd;
	return fail(`bun run service supports Linux (systemd) and macOS (launchd), not ${OS}.`);
}

async function install(): Promise<void> {
	const ops = service();
	const webArg = argValue("--web");
	const web = webArg ? resolve(webArg) : "";
	if (!existsSync(DAEMON)) fail(`No store binary at ${DAEMON}. Build it first, in ${REPO_DIR}: odin build src -o:speed -out:glon-odin`);
	if (web && !existsSync(join(web, "package.json"))) fail(`--web ${webArg}: no package.json in ${web}`);
	const args = [process.execPath, "run", "src/service.ts", "run", ...(web ? ["--web", web] : [])];
	// `bun run` prepends every node_modules/.bin up the tree; the service needs only the user's own PATH.
	const path = [...new Set((process.env.PATH ?? "/usr/bin:/bin").split(":").filter((dir) => dir && !dir.endsWith("/node_modules/.bin")))];
	const env: Record<string, string> = { PATH: path.join(":") };
	for (const key of PASSED_ENV) if (process.env[key]) env[key] = process.env[key] as string;
	env.ROOSTR_SERVICE = OS === "linux" ? "systemd" : "launchd";
	const wasActive = ops.active();

	if (OS === "linux") {
		mkdirSync(dirname(UNIT_PATH), { recursive: true });
		writeFileSync(UNIT_PATH, systemdUnit(args, env));
		if (!sh(["systemctl", "--user", "daemon-reload"]) || !sh(["systemctl", "--user", "enable", UNIT])) fail("systemctl could not enable roostr.service");
		// Lingering starts the user's services at boot instead of at their first login.
		const user = userInfo().username;
		if (capture(["loginctl", "show-user", user, "-p", "Linger", "--value"]) !== "yes" && !sh(["loginctl", "enable-linger", user])) {
			console.log(`Roostr starts at your next login. To start it at boot, run: sudo loginctl enable-linger ${user}`);
		}
	} else {
		for (const label of LEGACY_LABELS) {
			capture(["launchctl", "bootout", `${DOMAIN}/${label}`]);
			const legacy = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
			if (existsSync(legacy)) unlinkSync(legacy);
		}
		mkdirSync(dirname(PLIST_PATH), { recursive: true });
		mkdirSync(dirname(MAC_LOG), { recursive: true });
		// launchd reads a plist only when it is bootstrapped: unload the old one first.
		if (wasActive) capture(["launchctl", "bootout", `${DOMAIN}/${LABEL}`]);
		writeFileSync(PLIST_PATH, launchdPlist(args, env));
	}
	console.log(`Wrote ${OS === "linux" ? UNIT_PATH : PLIST_PATH}`);

	if (wasActive) {
		if (OS === "linux" ? !ops.restart() : !ops.start()) fail("The service did not restart; see: bun run service logs");
		console.log("Restarted the service with the new settings.");
	} else if (await storeAnswers()) {
		console.log(`Roostr is already running outside the service (the store answers on port ${STORE_PORT}). Stop those copies, then run: bun run service restart`);
	} else {
		if (!ops.start()) fail("The service did not start; see: bun run service logs");
		console.log("Started. Follow it with: bun run service logs");
	}
}

async function uninstall(): Promise<void> {
	service();
	// While the store still runs: this computer no longer starts by itself.
	try {
		const mine = await ownMachine();
		if (mine && flag(mine.fields, AUTOSTART_KEY)) await setField(mine.id, AUTOSTART_KEY, bv(false));
	} catch (err) {
		console.log(`Could not untick Starts automatically (${err instanceof Error ? err.message : String(err)}); the harness corrects it on its next start.`);
	}
	if (OS === "linux") {
		capture(["systemctl", "--user", "disable", "--now", UNIT]);
		if (existsSync(UNIT_PATH)) unlinkSync(UNIT_PATH);
		capture(["systemctl", "--user", "daemon-reload"]);
	} else {
		capture(["launchctl", "bootout", `${DOMAIN}/${LABEL}`]);
		if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
	}
	console.log("Stopped and removed the Roostr service.");
}

const cmd = process.argv[2];
if (cmd === "install") await install();
else if (cmd === "uninstall") await uninstall();
else if (cmd === "restart") {
	if (!service().restart()) fail("The service did not restart; see: bun run service logs");
} else if (cmd === "logs") {
	service();
	sh(OS === "linux" ? ["journalctl", "--user", "-u", UNIT, "-n", "200", "-f"] : ["tail", "-n", "200", "-f", MAC_LOG]);
} else if (cmd === "run") await supervise(programs(argValue("--web") ? resolve(argValue("--web")) : ""));
else {
	console.log("usage: bun run service install [--web <path>] | uninstall | restart | logs | run [--web <path>]");
	process.exit(cmd ? 1 : 0);
}
