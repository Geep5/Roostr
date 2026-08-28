/**
 * Backlinks — objects whose fields link TO a given object. Anytype surfaces
 * this as a featured-row cell ("N backlinks", block/featured.tsx renderLinks).
 * Link shapes mirror lib/graph.ts: linkValue fields, linkValue list items,
 * and collectionIds membership.
 */

import { fetchQuery } from "$lib/api";

export interface Backlink {
	id: string;
	name: string;
	typeKey: string;
	icon: string;
}

export async function fetchBacklinks(objectId: string): Promise<Backlink[]> {
	const res = await fetchQuery({ limit: 2000 });
	const out: Backlink[] = [];
	for (const r of res.records) {
		if (r.id === objectId) continue;
		let links = false;
		for (const [key, v] of Object.entries(r.fields)) {
			if (key === "channel") continue; // scoping, not a link
			if (v.linkValue?.targetId === objectId) links = true;
			else if (v.valuesValue) {
				for (const item of v.valuesValue.items) {
					if (item.linkValue?.targetId === objectId) links = true;
					else if (key === "collectionIds" && item.stringValue === objectId) links = true;
				}
			}
			if (links) break;
		}
		if (links) {
			out.push({
				id: r.id,
				name: r.fields["name"]?.stringValue || "Untitled",
				typeKey: r.typeKey,
				icon: r.fields["iconEmoji"]?.stringValue ?? "",
			});
		}
	}
	return out;
}
