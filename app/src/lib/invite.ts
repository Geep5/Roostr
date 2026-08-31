/**
 * Space invite links: a universal URL any Roostr client can open to join
 * a space. The secret space key rides in the URL fragment (never sent to
 * a server), so holding the link IS access — revoke by rotating the key.
 * The blob is `r1.` + base64url(JSON) so it survives chat apps, QR codes,
 * and copy-paste; the /j page on the web decodes and imports it.
 */

export interface SpaceInvite {
	v: 1;
	t: "space-invite";
	/** Channel (space) object id. */
	space: string;
	/** Space display name, for the join page. */
	name?: string;
	/** Owner npub, informational. */
	owner: string;
	/** Relays where the space lives. */
	relays: string[];
	/** Space key, 64-hex. Anyone holding it can read the space. */
	key: string;
	/** Key generation the link was minted for. */
	keyId: number;
	/** Optional deep-link object id inside the space. */
	object?: string;
}

/** Unicode-safe base64url (no padding). */
function b64urlEncode(s: string): string {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string | null {
	try {
		const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
		return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
	} catch {
		return null;
	}
}

export function encodeInvite(inv: SpaceInvite): string {
	return "r1." + b64urlEncode(JSON.stringify(inv));
}

/** Tolerant decode: whitespace from wrapping/paste is stripped; anything
 * that isn't a well-formed space invite returns null. */
export function decodeInvite(blob: string): SpaceInvite | null {
	const clean = blob.replace(/\s+/g, "");
	if (!clean.startsWith("r1.")) return null;
	const json = b64urlDecode(clean.slice(3));
	if (!json) return null;
	try {
		const inv = JSON.parse(json) as Partial<SpaceInvite>;
		if (inv.t !== "space-invite") return null;
		if (typeof inv.space !== "string" || !inv.space) return null;
		if (typeof inv.key !== "string" || !inv.key) return null;
		return {
			v: 1,
			t: "space-invite",
			space: inv.space,
			name: typeof inv.name === "string" ? inv.name : undefined,
			owner: typeof inv.owner === "string" ? inv.owner : "",
			relays: Array.isArray(inv.relays) ? inv.relays.filter((r): r is string => typeof r === "string") : [],
			key: inv.key,
			keyId: typeof inv.keyId === "number" ? inv.keyId : 1,
			object: typeof inv.object === "string" && inv.object ? inv.object : undefined,
		};
	} catch {
		return null;
	}
}

export function inviteUrl(inv: SpaceInvite): string {
	return `https://getroostr.fly.dev/j#${encodeInvite(inv)}`;
}
