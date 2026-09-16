/**
 * Auth requirements on task objects.
 *
 * Objects declare which local identities they need with `requires_auth`:
 * entries are `service` or `service:account`. The harness resolves those
 * selectors against machine-local auth state; secrets never enter the DAG.
 */
import { credentialStatus } from "./credentials";
import { googleAccountStatus } from "./google";

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

/** Prompt section describing the object's resolved auth contract. */
export function authRequirementsPrompt(resolutions: AuthResolution[]): string {
	if (resolutions.length === 0) return "";
	const lines = resolutions.map((r) => `- ${r.raw}: ${r.active ? "active" : `MISSING - ${r.reason}`}`);
	return `<auth-requirements>\nThis object declares these auth requirements. Use exactly these identities; never substitute another account. If any is MISSING, file a holdup and do not complete the task:\n${lines.join("\n")}\n</auth-requirements>`;
}
