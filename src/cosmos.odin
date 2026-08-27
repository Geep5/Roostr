package glon

// glon-odin cosmos — native 3D view of the object graph.
//
// Architecture (Anytype's graph worker, translated to native + 3D):
//   - d3-force semantics ported to 3D (charge −250, link distance 100,
//     weak centering, cluster pull toward channel nodes)
//   - wgpu (Metal on macOS) + GLFW window
//   - one instanced draw of SDF sphere impostors for all nodes
//   - one line-list draw for all edges
//   - orbit camera; hover names the object in the window title;
//     click opens it in the web app; R rebuilds the graph from disk.
//
// `cosmos --shot out.png` renders headlessly and writes a PNG (used
// for automated verification).

import "base:runtime"
import "core:fmt"
import "core:math"
import "core:math/rand"
import "core:math/linalg"
import "core:strings"
import "core:c/libc"
import stbi "vendor:stb/image"
import "vendor:glfw"
import "vendor:wgpu"
import "vendor:wgpu/glfwglue"

// ── Graph model ──────────────────────────────────────────────────────

Node :: struct {
	id:      string,
	name:    string,
	kind:    string,
	radius:  f32,
	color:   [3]f32,
	cluster: int, // node index of this node's channel (-1 = none)
	pos:     [3]f32,
	vel:     [3]f32,
}

Edge :: struct {
	a, b:  int,
	color: [4]f32,
}

Graph :: struct {
	nodes: [dynamic]Node,
	edges: [dynamic]Edge,
}

COSMOS_HIDDEN :: []string{"program", "typescript", "json", "proto", "relation"}

type_color :: proc(kind: string) -> [3]f32 {
	switch kind {
	case "channel":
		return {1.00, 0.63, 0.18} // accent
	case "note":
		return {0.42, 0.62, 0.95}
	case "task":
		return {0.36, 0.78, 0.72}
	case "query", "set":
		return {0.80, 0.52, 0.95}
	case "collection":
		return {0.95, 0.75, 0.35}
	case "person", "peer":
		return {0.90, 0.45, 0.55}
	case "agent":
		return {0.55, 0.85, 0.40}
	}
	// Stable hash palette for unknown types.
	h: u32 = 2166136261
	for ch in transmute([]byte)kind {
		h = (h ~ u32(ch)) * 16777619
	}
	return {0.35 + f32(h % 97) / 200.0, 0.35 + f32(h / 97 % 97) / 200.0, 0.45 + f32(h / 9409 % 97) / 250.0}
}

build_graph :: proc(allocator := context.allocator) -> Graph {
	g: Graph
	g.nodes = make([dynamic]Node, allocator)
	g.edges = make([dynamic]Edge, allocator)

	Ctx :: struct {
		g:         ^Graph,
		allocator: runtime.Allocator,
	}
	ctx := Ctx{&g, allocator}

	with_states(proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^struct {
			g:         ^Graph,
			allocator: runtime.Allocator,
		})user
		g := c.g
		index := make(map[string]int, allocator = context.temp_allocator)

		// Nodes.
		for id, s in states {
			if s.deleted do continue
			hidden := false
			for t in COSMOS_HIDDEN do if s.type_key == t {
				hidden = true
				break
			}
			if hidden do continue
			name := id[:8]
			if v, ok := fields_get(s.fields, "name"); ok && v.kind == .String && v.str != "" do name = v.str
			is_channel := s.type_key == "channel"
			radius: f32 = is_channel ? 22 : 10 + 2 * math.sqrt(f32(len(s.blocks)))
			index[id] = len(g.nodes)
			append(&g.nodes, Node{
				id      = strings.clone(id, c.allocator),
				name    = strings.clone(name, c.allocator),
				kind    = strings.clone(s.type_key, c.allocator),
				radius  = radius,
				color   = type_color(s.type_key),
				cluster = -1,
				pos     = {rand.float32_range(-300, 300), rand.float32_range(-300, 300), rand.float32_range(-300, 300)},
			})
		}

		// Edges.
		add_edge :: proc(g: ^Graph, index: map[string]int, a_id: string, b_idx: int, color: [4]f32) {
			ai, ok := index[a_id]
			if ok do append(&g.edges, Edge{ai, b_idx, color})
		}
		LINK_COLOR :: [4]f32{0.55, 0.65, 0.85, 0.55}
		CLUSTER_COLOR :: [4]f32{1.00, 0.63, 0.18, 0.25}
		COLLECTION_COLOR :: [4]f32{0.95, 0.75, 0.35, 0.30}
		QUERY_COLOR :: [4]f32{0.80, 0.52, 0.95, 0.40}

		for id, s in states {
			ni, in_graph := index[id]
			if !in_graph do continue
			for e in s.fields {
				// channel membership → cluster pull + faint edge
				if e.key == "channel" && e.value.kind == .String {
					if ci, ok := index[e.value.str]; ok {
						g.nodes[ni].cluster = ci
						append(&g.edges, Edge{ni, ci, CLUSTER_COLOR})
					}
					continue
				}
				// collection membership
				if e.key == "collectionIds" && e.value.kind == .List {
					for item in e.value.items {
						if item.kind == .String do add_edge(g, index, item.str, ni, COLLECTION_COLOR)
					}
					continue
				}
				// typed object links, single or in lists
				if e.value.kind == .Link {
					add_edge(g, index, e.value.link_target, ni, LINK_COLOR)
				} else if e.value.kind == .List {
					for item in e.value.items {
						if item.kind == .Link do add_edge(g, index, item.link_target, ni, LINK_COLOR)
					}
				}
			}
			// queries → edges to current matches
			if s.type_key == "query" || s.type_key == "set" {
				filter := resolve_set_filter(states, s)
				if filter != nil {
					matched := run_query(states, nil, filter)
					count := 0
					for m in matched {
						if mi, ok := index[m.id]; ok && mi != ni {
							append(&g.edges, Edge{ni, mi, QUERY_COLOR})
							count += 1
							if count >= 50 do break
						}
					}
				}
			}
		}
	}, &ctx)
	return g
}

// ── Force simulation (d3-force semantics in 3D) ──────────────────────

sim_step :: proc(g: ^Graph, alpha: f32) {
	CHARGE :: f32(-250)
	LINK_DIST :: f32(100)
	CENTER :: f32(0.01)
	CLUSTER :: f32(0.05)
	VELOCITY_DECAY :: f32(0.6) // d3 velocityDecay 0.4 → v *= 0.6

	n := len(g.nodes)
	// Charge (many-body), O(n²) — fine for a few hundred nodes.
	for i in 0 ..< n {
		for j in i + 1 ..< n {
			d := g.nodes[j].pos - g.nodes[i].pos
			l2 := max(linalg.length2(d), 25)
			l := math.sqrt(l2)
			f := CHARGE * alpha / l2
			dir := d / l
			g.nodes[i].vel += dir * f
			g.nodes[j].vel -= dir * f
		}
	}
	// Links.
	for e in g.edges {
		a := &g.nodes[e.a]
		b := &g.nodes[e.b]
		d := b.pos - a.pos
		l := max(linalg.length(d), 1)
		f := (l - LINK_DIST) / l * alpha * 0.3
		a.vel += d * f * 0.5
		b.vel -= d * f * 0.5
	}
	// Centering + cluster pull + integrate.
	for &node in g.nodes {
		node.vel -= node.pos * CENTER * alpha
		if node.cluster >= 0 {
			node.vel += (g.nodes[node.cluster].pos - node.pos) * CLUSTER * alpha
		}
		node.vel *= VELOCITY_DECAY
		node.pos += node.vel
	}
}

// ── Renderer ─────────────────────────────────────────────────────────

SHADER_WGSL :: `
struct Uniforms {
	view_proj: mat4x4<f32>,
	cam_right: vec4<f32>,
	cam_up:    vec4<f32>,
	misc:      vec4<f32>, // x: hovered instance, y: time
};
@group(0) @binding(0) var<uniform> U: Uniforms;

struct NodeOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,
	@location(1) color: vec3<f32>,
	@location(2) hovered: f32,
};

@vertex
fn vs_node(
	@builtin(vertex_index) vi: u32,
	@builtin(instance_index) ii: u32,
	@location(0) center_radius: vec4<f32>,
	@location(1) color_kind: vec4<f32>,
) -> NodeOut {
	// two-triangle quad from vertex index
	var corners = array<vec2<f32>, 6>(
		vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
		vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
	);
	let c = corners[vi];
	let hovered = select(0.0, 1.0, f32(ii) == U.misc.x);
	let r = center_radius.w * (1.0 + 0.25 * hovered);
	let world = center_radius.xyz + (U.cam_right.xyz * c.x + U.cam_up.xyz * c.y) * r;
	var out: NodeOut;
	out.pos = U.view_proj * vec4(world, 1.0);
	out.uv = c;
	out.color = color_kind.rgb;
	out.hovered = hovered;
	return out;
}

@fragment
fn fs_node(in: NodeOut) -> @location(0) vec4<f32> {
	let d2 = dot(in.uv, in.uv);
	if (d2 > 1.0) { discard; }
	let z = sqrt(1.0 - d2);
	let normal = vec3(in.uv, z);
	let light = normalize(vec3(0.4, 0.6, 0.8));
	let lambert = max(dot(normal, light), 0.0);
	let rim = pow(1.0 - z, 2.0);
	var col = in.color * (0.25 + 0.75 * lambert) + rim * in.color * 0.6;
	col += in.hovered * vec3(0.25);
	return vec4(col, 1.0);
}

struct EdgeOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) color: vec4<f32>,
};

@vertex
fn vs_edge(@location(0) p: vec4<f32>, @location(1) color: vec4<f32>) -> EdgeOut {
	var out: EdgeOut;
	out.pos = U.view_proj * vec4(p.xyz, 1.0);
	out.color = color;
	return out;
}

@fragment
fn fs_edge(in: EdgeOut) -> @location(0) vec4<f32> {
	return in.color;
}
`

Uniforms :: struct {
	view_proj: matrix[4, 4]f32,
	cam_right: [4]f32,
	cam_up:    [4]f32,
	misc:      [4]f32,
}

Renderer :: struct {
	ctx:            runtime.Context,
	window:         glfw.WindowHandle,
	instance:       wgpu.Instance,
	surface:        wgpu.Surface,
	adapter:        wgpu.Adapter,
	device:         wgpu.Device,
	queue:          wgpu.Queue,
	config:         wgpu.SurfaceConfiguration,
	node_pipeline:  wgpu.RenderPipeline,
	edge_pipeline:  wgpu.RenderPipeline,
	uniform_buf:    wgpu.Buffer,
	bind_group:     wgpu.BindGroup,
	node_buf:       wgpu.Buffer,
	edge_buf:       wgpu.Buffer,
	depth:          wgpu.Texture,
	depth_view:     wgpu.TextureView,
	node_capacity:  int,
	edge_capacity:  int,
	ready:          bool,
}

g_r: Renderer

// Orbit camera + interaction state.
g_cam: struct {
	yaw, pitch, dist: f32,
	target:           [3]f32,
	dragging:         bool,
	panning:          bool,
	last_x, last_y:   f64,
	moved:            f64,
}

g_graph: Graph
g_hovered: int = -1
g_alpha: f32 = 1.0
g_auto_fit := true // camera tracks the settling layout until the user takes over

auto_fit_camera :: proc() {
	if !g_auto_fit || len(g_graph.nodes) == 0 do return
	r: f32 = 0
	for node in g_graph.nodes {
		r = max(r, linalg.length(node.pos) + node.radius)
	}
	g_cam.dist = clamp(max(r * 2.6, 220), 50, 8000)
}

ensure_depth :: proc(w, h: u32) {
	if g_r.depth != nil {
		wgpu.TextureViewRelease(g_r.depth_view)
		wgpu.TextureRelease(g_r.depth)
	}
	g_r.depth = wgpu.DeviceCreateTexture(g_r.device, &{
		usage = {.RenderAttachment},
		dimension = ._2D,
		size = {w, h, 1},
		format = .Depth24Plus,
		mipLevelCount = 1,
		sampleCount = 1,
	})
	g_r.depth_view = wgpu.TextureCreateView(g_r.depth, nil)
}

camera_eye :: proc() -> [3]f32 {
	cp := math.cos(g_cam.pitch)
	dir := [3]f32{cp * math.cos(g_cam.yaw), math.sin(g_cam.pitch), cp * math.sin(g_cam.yaw)}
	return g_cam.target + dir * g_cam.dist
}

view_proj :: proc(w, h: f32) -> (vp: matrix[4, 4]f32, right, up: [3]f32) {
	eye := camera_eye()
	view := linalg.matrix4_look_at_f32(eye, g_cam.target, {0, 1, 0})
	proj := linalg.matrix4_perspective_f32(math.to_radians_f32(60), w / h, 1, 20000)
	// GL depth −1..1 → wgpu 0..1
	depth_fix := matrix[4, 4]f32{
		1, 0, 0, 0,
		0, 1, 0, 0,
		0, 0, 0.5, 0.5,
		0, 0, 0, 1,
	}
	vp = depth_fix * proj * view
	fwd := linalg.normalize(g_cam.target - eye)
	right = linalg.normalize(linalg.cross(fwd, [3]f32{0, 1, 0}))
	up = linalg.normalize(linalg.cross(right, fwd))
	return
}

/** Ray-sphere pick; returns node index or -1. */
pick :: proc(mx, my: f64, w, h: f32) -> int {
	vp, _, _ := view_proj(w, h)
	inv := linalg.inverse(vp)
	ndc_x := f32(mx) / w * 2 - 1
	ndc_y := 1 - f32(my) / h * 2
	p0 := inv * [4]f32{ndc_x, ndc_y, 0.01, 1}
	p1 := inv * [4]f32{ndc_x, ndc_y, 0.99, 1}
	o := [3]f32{p0.x / p0.w, p0.y / p0.w, p0.z / p0.w}
	e := [3]f32{p1.x / p1.w, p1.y / p1.w, p1.z / p1.w}
	dir := linalg.normalize(e - o)

	best := -1
	best_t := f32(1e30)
	for node, i in g_graph.nodes {
		oc := node.pos - o
		t := linalg.dot(oc, dir)
		if t < 0 do continue
		closest := o + dir * t
		if linalg.length(node.pos - closest) <= node.radius * 1.1 && t < best_t {
			best_t = t
			best = i
		}
	}
	return best
}

frame :: proc(w, h: u32) -> bool {
	surface_tex := wgpu.SurfaceGetCurrentTexture(g_r.surface)
	#partial switch surface_tex.status {
	case .SuccessOptimal, .SuccessSuboptimal:
	case:
		return false
	}
	defer wgpu.TextureRelease(surface_tex.texture)
	view := wgpu.TextureCreateView(surface_tex.texture, nil)
	defer wgpu.TextureViewRelease(view)

	render_to(view, w, h)
	wgpu.SurfacePresent(g_r.surface)
	return true
}

render_to :: proc(view: wgpu.TextureView, w, h: u32) {
	// Sim substeps (settling force layout).
	if g_alpha > 0.003 {
		for _ in 0 ..< 2 do sim_step(&g_graph, g_alpha)
		g_alpha *= 0.985
		auto_fit_camera()
	}


	// Uniforms.
	vp, right, up := view_proj(f32(w), f32(h))
	u := Uniforms{
		view_proj = vp,
		cam_right = {right.x, right.y, right.z, 0},
		cam_up    = {up.x, up.y, up.z, 0},
		misc      = {f32(g_hovered), 0, 0, 0},
	}
	wgpu.QueueWriteBuffer(g_r.queue, g_r.uniform_buf, 0, &u, size_of(Uniforms))

	// Instances.
	inst := make([][8]f32, len(g_graph.nodes), context.temp_allocator)
	for node, i in g_graph.nodes {
		inst[i] = {node.pos.x, node.pos.y, node.pos.z, node.radius, node.color.r, node.color.g, node.color.b, 0}
	}
	if len(inst) > 0 {
		wgpu.QueueWriteBuffer(g_r.queue, g_r.node_buf, 0, raw_data(inst), uint(len(inst) * size_of([8]f32)))
	}

	// Edge vertices.
	verts := make([][8]f32, len(g_graph.edges) * 2, context.temp_allocator)
	for e, i in g_graph.edges {
		a := g_graph.nodes[e.a]
		b := g_graph.nodes[e.b]
		verts[i * 2 + 0] = {a.pos.x, a.pos.y, a.pos.z, 1, e.color.r, e.color.g, e.color.b, e.color.a}
		verts[i * 2 + 1] = {b.pos.x, b.pos.y, b.pos.z, 1, e.color.r, e.color.g, e.color.b, e.color.a}
	}
	if len(verts) > 0 {
		wgpu.QueueWriteBuffer(g_r.queue, g_r.edge_buf, 0, raw_data(verts), uint(len(verts) * size_of([8]f32)))
	}

	encoder := wgpu.DeviceCreateCommandEncoder(g_r.device, nil)
	defer wgpu.CommandEncoderRelease(encoder)

	pass := wgpu.CommandEncoderBeginRenderPass(encoder, &{
		colorAttachmentCount = 1,
		colorAttachments = &wgpu.RenderPassColorAttachment{
			view = view,
			loadOp = .Clear,
			storeOp = .Store,
			depthSlice = wgpu.DEPTH_SLICE_UNDEFINED,
			clearValue = {0.047, 0.055, 0.066, 1},
		},
		depthStencilAttachment = &wgpu.RenderPassDepthStencilAttachment{
			view = g_r.depth_view,
			depthLoadOp = .Clear,
			depthStoreOp = .Store,
			depthClearValue = 1,
		},
	})

	wgpu.RenderPassEncoderSetBindGroup(pass, 0, g_r.bind_group)
	if len(g_graph.edges) > 0 {
		wgpu.RenderPassEncoderSetPipeline(pass, g_r.edge_pipeline)
		wgpu.RenderPassEncoderSetVertexBuffer(pass, 0, g_r.edge_buf, 0, u64(len(verts) * size_of([8]f32)))
		wgpu.RenderPassEncoderDraw(pass, u32(len(verts)), 1, 0, 0)
	}
	if len(g_graph.nodes) > 0 {
		wgpu.RenderPassEncoderSetPipeline(pass, g_r.node_pipeline)
		wgpu.RenderPassEncoderSetVertexBuffer(pass, 0, g_r.node_buf, 0, u64(len(inst) * size_of([8]f32)))
		wgpu.RenderPassEncoderDraw(pass, 6, u32(len(inst)), 0, 0)
	}
	wgpu.RenderPassEncoderEnd(pass)
	wgpu.RenderPassEncoderRelease(pass)

	cmd := wgpu.CommandEncoderFinish(encoder, nil)
	defer wgpu.CommandBufferRelease(cmd)
	wgpu.QueueSubmit(g_r.queue, {cmd})
}

setup_pipelines :: proc() {
	module := wgpu.DeviceCreateShaderModule(g_r.device, &{
		nextInChain = &wgpu.ShaderSourceWGSL{sType = .ShaderSourceWGSL, code = SHADER_WGSL},
	})

	g_r.uniform_buf = wgpu.DeviceCreateBuffer(g_r.device, &{
		usage = {.Uniform, .CopyDst},
		size  = size_of(Uniforms),
	})

	bgl := wgpu.DeviceCreateBindGroupLayout(g_r.device, &{
		entryCount = 1,
		entries = &wgpu.BindGroupLayoutEntry{
			binding = 0,
			visibility = {.Vertex, .Fragment},
			buffer = {type = .Uniform, minBindingSize = size_of(Uniforms)},
		},
	})
	g_r.bind_group = wgpu.DeviceCreateBindGroup(g_r.device, &{
		layout = bgl,
		entryCount = 1,
		entries = &wgpu.BindGroupEntry{binding = 0, buffer = g_r.uniform_buf, size = size_of(Uniforms)},
	})
	layout := wgpu.DeviceCreatePipelineLayout(g_r.device, &{
		bindGroupLayoutCount = 1,
		bindGroupLayouts = &bgl,
	})

	// Node pipeline: per-instance attributes, quad from vertex index.
	node_attrs := []wgpu.VertexAttribute{
		{format = .Float32x4, offset = 0, shaderLocation = 0},
		{format = .Float32x4, offset = 16, shaderLocation = 1},
	}
	node_layout := wgpu.VertexBufferLayout{
		arrayStride = size_of([8]f32),
		stepMode = .Instance,
		attributeCount = len(node_attrs),
		attributes = raw_data(node_attrs),
	}
	depth_state := wgpu.DepthStencilState{
		format = .Depth24Plus,
		depthWriteEnabled = .True,
		depthCompare = .Less,
		stencilFront = {compare = .Always, failOp = .Keep, depthFailOp = .Keep, passOp = .Keep},
		stencilBack = {compare = .Always, failOp = .Keep, depthFailOp = .Keep, passOp = .Keep},
		stencilReadMask = 0xFFFFFFFF,
		stencilWriteMask = 0xFFFFFFFF,
	}
	g_r.node_pipeline = wgpu.DeviceCreateRenderPipeline(g_r.device, &{
		layout = layout,
		vertex = {module = module, entryPoint = "vs_node", bufferCount = 1, buffers = &node_layout},
		fragment = &wgpu.FragmentState{
			module = module,
			entryPoint = "fs_node",
			targetCount = 1,
			targets = &wgpu.ColorTargetState{format = g_r.config.format, writeMask = wgpu.ColorWriteMaskFlags_All},
		},
		primitive = {topology = .TriangleList, cullMode = .None},
		depthStencil = &depth_state,
		multisample = {count = 1, mask = 0xFFFFFFFF},
	})

	// Edge pipeline: line list, alpha blend, no depth write.
	edge_attrs := []wgpu.VertexAttribute{
		{format = .Float32x4, offset = 0, shaderLocation = 0},
		{format = .Float32x4, offset = 16, shaderLocation = 1},
	}
	edge_layout := wgpu.VertexBufferLayout{
		arrayStride = size_of([8]f32),
		stepMode = .Vertex,
		attributeCount = len(edge_attrs),
		attributes = raw_data(edge_attrs),
	}
	blend := wgpu.BlendState{
		color = {srcFactor = .SrcAlpha, dstFactor = .OneMinusSrcAlpha, operation = .Add},
		alpha = {srcFactor = .One, dstFactor = .OneMinusSrcAlpha, operation = .Add},
	}
	edge_depth := depth_state
	edge_depth.depthWriteEnabled = .False
	g_r.edge_pipeline = wgpu.DeviceCreateRenderPipeline(g_r.device, &{
		layout = layout,
		vertex = {module = module, entryPoint = "vs_edge", bufferCount = 1, buffers = &edge_layout},
		fragment = &wgpu.FragmentState{
			module = module,
			entryPoint = "fs_edge",
			targetCount = 1,
			targets = &wgpu.ColorTargetState{format = g_r.config.format, blend = &blend, writeMask = wgpu.ColorWriteMaskFlags_All},
		},
		primitive = {topology = .LineList},
		depthStencil = &edge_depth,
		multisample = {count = 1, mask = 0xFFFFFFFF},
	})

	// Geometry buffers, generously sized.
	g_r.node_capacity = max(len(g_graph.nodes) * 2, 1024)
	g_r.edge_capacity = max(len(g_graph.edges) * 4, 4096)
	g_r.node_buf = wgpu.DeviceCreateBuffer(g_r.device, &{
		usage = {.Vertex, .CopyDst},
		size  = u64(g_r.node_capacity * size_of([8]f32)),
	})
	g_r.edge_buf = wgpu.DeviceCreateBuffer(g_r.device, &{
		usage = {.Vertex, .CopyDst},
		size  = u64(g_r.edge_capacity * 2 * size_of([8]f32)),
	})
}

// ── Entry ────────────────────────────────────────────────────────────

cosmos :: proc(shot_path: string) {
	g_graph = build_graph()
	fmt.printfln("[cosmos] %d nodes, %d edges", len(g_graph.nodes), len(g_graph.edges))

	g_cam.yaw = 0.6
	g_cam.pitch = 0.35
	g_cam.dist = 900

	if !glfw.Init() {
		fmt.eprintln("[cosmos] glfw init failed")
		return
	}
	defer glfw.Terminate()
	glfw.WindowHint(glfw.CLIENT_API, glfw.NO_API)
	if shot_path != "" do glfw.WindowHint(glfw.VISIBLE, glfw.FALSE)
	g_r.window = glfw.CreateWindow(1280, 860, "glon cosmos", nil, nil)
	if g_r.window == nil {
		fmt.eprintln("[cosmos] window creation failed")
		return
	}
	defer glfw.DestroyWindow(g_r.window)

	g_r.ctx = context
	g_r.instance = wgpu.CreateInstance(nil)
	g_r.surface = glfwglue.GetSurface(g_r.instance, g_r.window)

	wgpu.InstanceRequestAdapter(g_r.instance, &{compatibleSurface = g_r.surface}, {callback = on_adapter})

	on_adapter :: proc "c" (status: wgpu.RequestAdapterStatus, adapter: wgpu.Adapter, message: string, u1, u2: rawptr) {
		context = g_r.ctx
		if status != .Success || adapter == nil do fmt.panicf("adapter: %v %s", status, message)
		g_r.adapter = adapter
		wgpu.AdapterRequestDevice(adapter, nil, {callback = on_device})
	}
	on_device :: proc "c" (status: wgpu.RequestDeviceStatus, device: wgpu.Device, message: string, u1, u2: rawptr) {
		context = g_r.ctx
		if status != .Success || device == nil do fmt.panicf("device: %v %s", status, message)
		g_r.device = device
		g_r.queue = wgpu.DeviceGetQueue(device)

		w, h := glfw.GetFramebufferSize(g_r.window)
		caps, _ := wgpu.SurfaceGetCapabilities(g_r.surface, g_r.adapter)
		// Prefer a non-sRGB format: shader colors are authored in display space.
		format := wgpu.TextureFormat.BGRA8Unorm
		found := false
		for i in 0 ..< caps.formatCount {
			f := caps.formats[i]
			if f == .BGRA8Unorm || f == .RGBA8Unorm {
				format = f
				found = true
				break
			}
		}
		if !found && caps.formatCount > 0 do format = caps.formats[0]
		g_r.config = {
			device      = device,
			usage       = {.RenderAttachment},
			format      = format,
			width       = u32(w),
			height      = u32(h),
			presentMode = .Fifo,
			alphaMode   = .Opaque,
		}
		wgpu.SurfaceConfigure(g_r.surface, &g_r.config)
		ensure_depth(u32(w), u32(h))
		setup_pipelines()
		g_r.ready = true
	}

	for !g_r.ready {
		wgpu.InstanceProcessEvents(g_r.instance)
	}

	install_input()

	if shot_path != "" {
		run_shot(shot_path)
		return
	}

	for !glfw.WindowShouldClose(g_r.window) {
		glfw.PollEvents()
		w, h := glfw.GetFramebufferSize(g_r.window)
		if u32(w) != g_r.config.width || u32(h) != g_r.config.height {
			g_r.config.width = u32(w)
			g_r.config.height = u32(h)
			wgpu.SurfaceConfigure(g_r.surface, &g_r.config)
			ensure_depth(u32(w), u32(h))
		}
		_ = frame(u32(w), u32(h))
		free_all(context.temp_allocator)
	}
}

install_input :: proc() {
	glfw.SetMouseButtonCallback(g_r.window, proc "c" (window: glfw.WindowHandle, button, action, mods: i32) {
		context = g_r.ctx
		if button == glfw.MOUSE_BUTTON_LEFT {
			if action == glfw.PRESS {
				g_cam.dragging = true
				g_auto_fit = false
				g_cam.moved = 0
				g_cam.last_x, g_cam.last_y = glfw.GetCursorPos(window)
			} else if action == glfw.RELEASE {
				g_cam.dragging = false
				if g_cam.moved < 4 {
					// click: open hovered object in the web app
					mx, my := glfw.GetCursorPos(window)
					fw, fh := glfw.GetFramebufferSize(window)
					ww, _ := glfw.GetWindowSize(window)
					scale := f64(fw) / f64(ww)
					idx := pick(mx * scale, my * scale, f32(fw), f32(fh))
					if idx >= 0 {
						cmd := fmt.ctprintf("open 'http://localhost:5190/object/%s'", g_graph.nodes[idx].id)
						libc.system(cmd)
					}
				}
			}
		}
		if button == glfw.MOUSE_BUTTON_RIGHT {
			g_cam.panning = action == glfw.PRESS
			g_cam.last_x, g_cam.last_y = glfw.GetCursorPos(window)
		}
	})
	glfw.SetCursorPosCallback(g_r.window, proc "c" (window: glfw.WindowHandle, x, y: f64) {
		context = g_r.ctx
		dx := x - g_cam.last_x
		dy := y - g_cam.last_y
		if g_cam.dragging {
			g_cam.moved += math.abs(dx) + math.abs(dy)
			g_cam.yaw += f32(dx) * 0.008
			g_cam.pitch = clamp(g_cam.pitch + f32(dy) * 0.008, -1.5, 1.5)
			g_cam.last_x, g_cam.last_y = x, y
		} else if g_cam.panning {
			_, right, up := view_proj(f32(g_r.config.width), f32(g_r.config.height))
			g_cam.target -= right * f32(dx) * g_cam.dist * 0.0012
			g_cam.target += up * f32(dy) * g_cam.dist * 0.0012
			g_cam.last_x, g_cam.last_y = x, y
		} else {
			fw, fh := glfw.GetFramebufferSize(window)
			ww, _ := glfw.GetWindowSize(window)
			scale := f64(fw) / f64(ww)
			g_hovered = pick(x * scale, y * scale, f32(fw), f32(fh))
			if g_hovered >= 0 {
				node := g_graph.nodes[g_hovered]
				glfw.SetWindowTitle(window, fmt.ctprintf("glon cosmos — %s (%s)", node.name, node.kind))
				return
			}
			glfw.SetWindowTitle(window, "glon cosmos")
		}
	})
	glfw.SetScrollCallback(g_r.window, proc "c" (window: glfw.WindowHandle, dx, dy: f64) {
		context = g_r.ctx
		g_auto_fit = false
		g_cam.dist = clamp(g_cam.dist * math.exp(f32(-dy) * 0.1), 50, 8000)
	})
	glfw.SetKeyCallback(g_r.window, proc "c" (window: glfw.WindowHandle, key, scancode, action, mods: i32) {
		context = g_r.ctx
		if action != glfw.PRESS do return
		switch key {
		case glfw.KEY_R:
			store_invalidate()
			g_graph = build_graph()
			g_alpha = 1.0
			fmt.printfln("[cosmos] rebuilt: %d nodes, %d edges", len(g_graph.nodes), len(g_graph.edges))
		case glfw.KEY_ESCAPE:
			glfw.SetWindowShouldClose(window, true)
		}
	})
}

/** Headless verification: settle the layout, render offscreen, write PNG. */
run_shot :: proc(path: string) {
	w := g_r.config.width
	h := g_r.config.height

	for _ in 0 ..< 150 do sim_step(&g_graph, g_alpha)

	target := wgpu.DeviceCreateTexture(g_r.device, &{
		usage = {.RenderAttachment, .CopySrc},
		dimension = ._2D,
		size = {w, h, 1},
		format = g_r.config.format,
		mipLevelCount = 1,
		sampleCount = 1,
	})
	view := wgpu.TextureCreateView(target, nil)
	render_to(view, w, h)

	bytes_per_row := (w * 4 + 255) / 256 * 256
	readback := wgpu.DeviceCreateBuffer(g_r.device, &{
		usage = {.CopyDst, .MapRead},
		size  = u64(bytes_per_row * h),
	})
	encoder := wgpu.DeviceCreateCommandEncoder(g_r.device, nil)
	wgpu.CommandEncoderCopyTextureToBuffer(
		encoder,
		&{texture = target},
		&{buffer = readback, layout = {bytesPerRow = bytes_per_row, rowsPerImage = h}},
		&{w, h, 1},
	)
	cmd := wgpu.CommandEncoderFinish(encoder, nil)
	wgpu.QueueSubmit(g_r.queue, {cmd})

	done := false
	ctx_done := &done
	wgpu.BufferMapAsync(readback, {.Read}, 0, uint(bytes_per_row * h), {
		callback = proc "c" (status: wgpu.MapAsyncStatus, message: string, u1, u2: rawptr) {
			d := cast(^bool)u1
			d^ = true
		},
		userdata1 = ctx_done,
	})
	for !done {
		wgpu.DevicePoll(g_r.device, true, nil)
	}

	data := wgpu.BufferGetConstMappedRange(readback, 0, uint(bytes_per_row * h))
	// BGRA → RGBA, strip row padding.
	pixels := make([]byte, w * h * 4)
	src := ([^]byte)(raw_data(data))
	for row in 0 ..< h {
		for col in 0 ..< w {
			s := row * bytes_per_row + col * 4
			d := (row * w + col) * 4
			pixels[d + 0] = src[s + 2]
			pixels[d + 1] = src[s + 1]
			pixels[d + 2] = src[s + 0]
			pixels[d + 3] = 255
		}
	}
	cpath := strings.clone_to_cstring(path, context.temp_allocator)
	ok := stbi.write_png(cpath, i32(w), i32(h), 4, raw_data(pixels), i32(w * 4))
	fmt.printfln("[cosmos] shot %s: %s (%dx%d)", path, ok != 0 ? "written" : "FAILED", w, h)
}
