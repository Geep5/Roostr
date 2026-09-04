/**
 * Space join links: a public, key-free URL. Opening it lets anyone SEND
 * a join request (a NIP-59 gift wrap to the owner's npub); the owner
 * approves in space settings, and only then is the space key delivered -
 * gift-wrapped to the approved member's npub. The link itself grants
 * nothing: it names the space, its owner, and the relays to knock on.
 * Blob is `r2.` + base64url(JSON) so it survives chat apps and QR codes.
 */

export interface SpaceJoinLink {
	v: 2;
	t: "space-join";
	/** Channel (space) object id. */
	space: string;
	/** Space display name, for the join page. */
	name?: string;
	/** Owner npub - where the join request is addressed. */
	owner: string;
	/** Relays where the owner listens. */
	relays: string[];
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

export function encodeJoinLink(link: SpaceJoinLink): string {
	return "r2." + b64urlEncode(JSON.stringify(link));
}

/** Tolerant decode: whitespace from wrapping/paste is stripped; anything
 * that isn't a well-formed join link returns null. Key-carrying r1 links
 * are retired and no longer decode. */
export function decodeJoinLink(blob: string): SpaceJoinLink | null {
	const clean = blob.replace(/\s+/g, "");
	if (!clean.startsWith("r2.")) return null;
	const json = b64urlDecode(clean.slice(3));
	if (!json) return null;
	try {
		const link = JSON.parse(json) as Partial<SpaceJoinLink>;
		if (link.t !== "space-join") return null;
		if (typeof link.space !== "string" || !link.space) return null;
		if (typeof link.owner !== "string" || !link.owner) return null;
		return {
			v: 2,
			t: "space-join",
			space: link.space,
			name: typeof link.name === "string" ? link.name : undefined,
			owner: link.owner,
			relays: Array.isArray(link.relays) ? link.relays.filter((r): r is string => typeof r === "string") : [],
		};
	} catch {
		return null;
	}
}

export function joinUrl(link: SpaceJoinLink): string {
	return `https://getroostr.fly.dev/j#${encodeJoinLink(link)}`;
}
