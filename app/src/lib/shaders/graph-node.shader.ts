import { shader, vec2, vec3, vec4, length, smoothstep, max } from "brometal";

/**
 * Anytype-style 2D graph node: instanced anti-aliased circles.
 * iFlags: 0 normal, 1 hovered (brighter + ring).
 * Transform: screen = (world - uOffset) * uScale + uViewport/2, y-down world.
 */
export const GraphNode = shader({
	attributes: { aCorner: "vec2" },
	instanceAttributes: {
		iCenter: "vec2",
		iRadius: "float",
		iTint: "vec3",
		iFlags: "float",
	},
	uniforms: { uScale: "float", uOffset: "vec2", uViewport: "vec2" },
	varyings: { vUv: "vec2", vTint: "vec3", vFlags: "float" },

	vertex({ aCorner, iCenter, iRadius, iTint, iFlags }, { uScale, uOffset, uViewport }, v) {
		v.vUv = aCorner;
		v.vTint = iTint;
		v.vFlags = iFlags;
		const world = iCenter.add(aCorner.scale(iRadius * 1.25));
		const screen = world.sub(uOffset).scale(uScale).add(uViewport.scale(0.5));
		const clipX = (screen.x / uViewport.x) * 2 - 1;
		const clipY = 1 - (screen.y / uViewport.y) * 2;
		return vec4(vec2(clipX, clipY), 0, 1);
	},

	fragment(_uniforms, { vUv, vTint, vFlags }) {
		// Flat 2D disc (Anytype's graph look): anti-aliased fill, hover ring.
		// No sphere shading — simple, readable, calm.
		const s = vUv.scale(1.25);
		const d = length(s);
		const fill = 1 - smoothstep(0.9, 1.0, d);
		const ring = smoothstep(1.04, 1.1, d) * (1 - smoothstep(1.16, 1.24, d));
		const color = vTint.scale(1 + vFlags * 0.25).add(vec3(1, 1, 1).scale(ring * vFlags * 0.9));
		const alpha = max(fill, ring * vFlags);
		return vec4(color.scale(alpha), alpha);
	},
});
