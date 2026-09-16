/**
 * Auth requirements on task objects.
 *
 * Objects declare which local identities they need with `requires_auth`:
 * entries are `service` or `service:account`. The harness resolves those
 * selectors against machine-local auth state; secrets never enter the DAG.
 */
import { credentialStatus } from "./credentials";
import { googleAccountStatus, listGoogleAccounts } from "./google";

export interface AuthRequirement {
	service: string;
	account?: string;
	raw: string;
}

export interface AuthResolution extends AuthRequirement {
	active: boolean;
	reason: string;
}

/** Parse `service[:account]`; account may itself contain ':' only never does in our selectors. */
export function parseAuthRequirement(raw: string): AuthRequirement | null {
	const value = raw.trim();
	if (!value) return null;
	const colon = value.indexOf(":");
	if (colon < 0) return { service: value.toLowerCase(), raw };
	const service = value.slice(0, colon).trim().toLowerCase();
	const account = value.slice(colon + 1).trim();
	if (!service || !account) return null;
	return { service, account, raw };
}

export function authRequirementsOf(fields: Record<string, { stringValue?: string; valuesValue?: { items?: Array<{ stringValue?: string }> } }>): AuthRequirement[] {
	const field = fields["requires_auth"];
	const list = field?.valuesValue?.items ?? (field?.stringValue ? [{ stringValue: field.stringValue }] : []);
	const parsed = list
		.map((item) => parseAuthRequirement(item.stringValue ?? ""))
		.filter((item): item is AuthRequirement => item !== null);
	if (parsed.length > 0) return parsed;
	// Shorthand for the single-auth case.
	const service = fields["service"]?.stringValue?.trim().toLowerCase();
	const account = fields["account"]?.stringValue?.trim() || fields["google_account"]?.stringValue?.trim();
	return service ? [{ service, ...(account ? { account } : {}), raw: account ? `${service}:${account}` : service }] : [];
}

async function serviceActive(service: string): Promise<{ active: boolean; account?: string; reason: string }> {
	if (service === "browserless") {
		const { skillReady } = await import("./skillmgr");
		const ready = await skillReady("browserless");
		return { active: ready.ok, reason: ready.ok ? "browserless ready" : ready.reason };
	}
	const credential = credentialStatus().find((c) => c.key === service);
	if (credential) {
		const active = credential.active.browser || credential.active.password;
		return { active, account: active ? service : undefined, reason: active ? `${service} active` : `${service} is not set up on this machine` };
	}
	return { active: false, reason: `unknown auth service "${service}"` };
}

/** Resolve all requirements against this machine. Missing account on a multi-account service is an error, not a guess. */
export async function resolveAuthRequirements(requirements: AuthRequirement[]): Promise<AuthResolution[]> {
	return Promise.all(
		requirements.map(async (req) => {
			if (req.service === "google") {
				if (!req.account) return { ...req, active: false, reason: "google requires an account selector such as google:support@matcherino.com" };
				const status = await googleAccountStatus(req.account);
				const active = status.configured && status.authMethod !== "" && status.authMethod !== "none";
				return { ...req, active, reason: active ? `google account ${req.account} active (${status.authMethod})` : status.error ?? `google account ${req.account} needs auth` };
			}
			if (req.account) return { ...req, active: false, reason: `${req.service} does not take an account selector` };
			const status = await serviceActive(req.service);
			return { ...req, active: status.active, reason: status.reason };
		}),
	);
}

/** Services whose identity is ambiguous without an account selector. */
const MULTI_ACCOUNT = new Set(["google"]);

export interface AuthIdentity extends AuthRequirement {
	selector: string;
	active: boolean;
	reason: string;
}

/**
 * Every identity this machine can offer, as the selectors an object may
 * declare. This is the vocabulary an agent needs to set `requires_auth`
 * correctly - and the list every write is validated against.
 */
export async function localAuthRegistry(): Promise<AuthIdentity[]> {
	const rows: AuthIdentity[] = [];
	for (const c of credentialStatus()) {
		const active = c.active.browser || c.active.password;
		rows.push({
			selector: c.key,
			service: c.key,
			raw: c.key,
			active,
			reason: active ? `${c.key} active` : `${c.key} is not set up on this machine`,
		});
	}
	for (const g of await listGoogleAccounts()) {
		const active = g.configured && g.authMethod !== "" && g.authMethod !== "none";
		rows.push({
			selector: `google:${g.account}`,
			service: "google",
			account: g.account,
			raw: `google:${g.account}`,
			active,
			reason: active ? `google account ${g.account} active (${g.authMethod})` : `google account ${g.account} needs auth`,
		});
	}
	const browserless = await serviceActive("browserless");
	rows.push({ selector: "browserless", service: "browserless", raw: "browserless", active: browserless.active, reason: browserless.reason });
	return rows;
}

/** Validate one selector against the machine's identities - no silent guesses. */
export function validateAuthSelector(raw: string, registry: AuthIdentity[]): { requirement: AuthRequirement } | { error: string } {
	const parsed = parseAuthRequirement(raw);
	if (!parsed) return { error: `"${raw}" is not a selector; use service or service:account` };
	const services = new Set([...registry.map((r) => r.service), ...MULTI_ACCOUNT]);
	if (!services.has(parsed.service)) return { error: `unknown auth service "${parsed.service}"; this machine knows ${[...services].sort().join(", ")}` };
	const accounts = registry.filter((r) => r.service === parsed.service && r.account).map((r) => r.account as string);
	if (MULTI_ACCOUNT.has(parsed.service)) {
		if (!parsed.account) return { error: `${parsed.service} needs an account selector, e.g. ${parsed.service}:${accounts[0] ?? "someone@example.com"}` };
		if (!accounts.includes(parsed.account)) return { error: `${parsed.service} account "${parsed.account}" is not configured here; configured: ${accounts.join(", ") || "none"}` };
	} else if (parsed.account) {
		return { error: `${parsed.service} does not take an account selector` };
	}
	return { requirement: parsed };
}

/**
 * The auth contract, always present: the property vocabulary, the
 * identities this machine can actually fulfill, and what the object
 * declares today. An agent that has never seen `requires_auth` can read
 * this and set it up correctly in the same turn.
 */
export function authContractPrompt(registry: AuthIdentity[], declared: AuthResolution[]): string {
	const lines = [
		"<auth-contract>",
		"Objects declare which identities their work needs; the serving machine fulfills them. Secrets never live on objects.",
		"Properties you set on a task object:",
		"- requires_auth (list): one entry per identity, `service` or `service:account`. google is multi-account and MUST name the account.",
		"- browserless (checkbox): the work needs this machine's headless browser to render pages.",
		"- external_action (checkbox): the work may write or act outside Roostr.",
		"Identities on this machine:",
		...registry.map((r) => `- ${r.selector}: ${r.active ? "active" : `needs setup - ${r.reason}`}`),
		"Write them with object_set_auth: it validates every selector against that list and reports each one's live status, so you can confirm an object will run before the scheduler fires it. Never invent a service, never substitute another account.",
	];
	lines.push(
		...(declared.length > 0
			? ["Declared on this object:", ...declared.map((r) => `- ${r.raw}: ${r.active ? "active" : `MISSING - ${r.reason}`}`), "If a requirement is MISSING, file a holdup and do not complete the work."]
			: ["This object declares no auth requirements yet. If its work needs an account, declare it."]),
	);
	lines.push("</auth-contract>");
	return lines.join("\n");
}
