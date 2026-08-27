import { shader, vec2, vec4, normalize } from "brometal";

/**
 * Instanced 2D edge ribbon: aQuad.y interpolates start→end, aQuad.x is
 * the across-axis; width is constant in screen pixels.
 */
export const GraphEdge = shader({
	attributes: { aQuad: "vec2" },
	instanceAttributes: { iStart: "vec2", iEnd: "vec2", iColor: "vec4" },
	uniforms: { uScale: "float", uOffset: "vec2", uViewport: "vec2", uWidth: "float" },
	varyings: { vColor: "vec4" },

	vertex({ aQuad, iStart, iEnd, iColor }, { uScale, uOffset, uViewport, uWidth }, v) {
		v.vColor = iColor;
		const a = iStart.sub(uOffset).scale(uScale).add(uViewport.scale(0.5));
		const b = iEnd.sub(uOffset).scale(uScale).add(uViewport.scale(0.5));
		const along = b.sub(a);
		const dir = normalize(along);
		const n = vec2(0 - dir.y, dir.x);
		const p = a.add(along.scale(aQuad.y)).add(n.scale(aQuad.x * uWidth * 0.5));
		const clipX = (p.x / uViewport.x) * 2 - 1;
		const clipY = 1 - (p.y / uViewport.y) * 2;
		return vec4(vec2(clipX, clipY), 0, 1);
	},

	fragment(_uniforms, { vColor }) {
		return vec4(vColor.xyz.scale(vColor.w), vColor.w);
	},
});
