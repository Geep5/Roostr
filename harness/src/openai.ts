/**
 * OpenAI, called with a space's OpenAI credential (service `openai`, its key
 * in `key_api_key`) by the computer that serves that credential. Two calls,
 * both for generated page covers (covers.ts):
 *
 * - the art director: the Responses API (`POST /v1/responses`, model
 *   {@link ART_DIRECTOR_MODEL}) turns a page's visible content into one image
 *   prompt, following {@link ART_DIRECTOR_INSTRUCTIONS};
 * - the painter: the Images API (`POST /v1/images/generations`, model
 *   {@link IMAGE_MODEL}, high quality, {@link COVER_SIZE}) paints it.
 *
 * A key OpenAI refuses (401/403) is remembered per credential and key, so
 * the credential's Error says so (credential-objects.ts) until the key
 * changes or a Check finds it working again. `OPENAI_BASE_URL` points the
 * calls elsewhere (the tests' fake server).
 */

export const OPENAI_SERVICE = "openai";

/** The text model that writes a cover's image prompt (OpenAI's flagship text model). */
export const ART_DIRECTOR_MODEL = "gpt-6-astra";
/** The image model that paints a cover. */
export const IMAGE_MODEL = "gpt-image-2.5-sunburst";
/**
 * Covers are wide banners: the widest aspect the image model allows (3:1),
 * at the largest size below its experimental range (2560x1440 = 3,686,400
 * pixels), both edges multiples of 16.
 */
export const COVER_SIZE = "3072x1024";
export const IMAGE_QUALITY = "high";
/** JPEG, not the default PNG: a photo-like 3072x1024 banner is a fraction of the size, and every device downloads it. */
export const IMAGE_FORMAT = "jpeg";

/**
 * The art director's standing instruction - the only text the model gets
 * besides the page's own visible content (covers.ts pageBrief): its title,
 * type, body text and properties as the page shows them.
 */
export const ART_DIRECTOR_INSTRUCTIONS = [
	"You are an art director. Write one image prompt for a WIDE website banner (a page cover, about 3:1, shown cropped behind the page's title) that fits the page described below.",
	"House style: a real photograph, abstract and minimal. Suggest the page's subject obliquely - a close crop of a material, surface, texture, light or shadow, water, sky or architecture that echoes it - never a literal scene, characters, mascots or objects arranged to tell the story.",
	"Natural light, a quiet muted palette (one or two colours at most), lots of empty space, shallow depth of field or soft focus where it helps. It must look like an unretouched photo from a good camera: no illustration, painting, 3D render, glow, sparkles, fantasy or sci-fi, no HDR, no surreal compositions.",
	"The image must contain no people, text, letters, numbers, logos, signatures or watermarks.",
	"Be concrete: name the subject, the light, the palette, the lens or framing (wide landscape, calm space at the edges).",
	"At most 60 words. Reply with the prompt only - no title, quotes or explanation.",
].join("\n");

/**
 * Sent with every cover prompt to the image model: the house style holds
 * even when the art director's prompt drifts toward illustration.
 */
export const COVER_STYLE =
	"Style: a real, unretouched photograph - abstract, minimal, natural light, muted palette, generous negative space, fine film grain. Not an illustration, painting or 3D render; no glow, fantasy, surreal elements, people or text.";

/** How long one call may take: high-quality images take tens of seconds. */
const TEXT_TIMEOUT_MS = 120_000;
const IMAGE_TIMEOUT_MS = 300_000;

export function openaiBase(): string {
	return (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
}

/** OpenAI said no: its own message, the HTTP status and its error code (`invalid_api_key`, `insufficient_quota`, `moderation_blocked`, …). */
export class OpenAIError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code: string,
	) {
		super(message);
	}

	/** The key itself was refused: the credential needs a new one. */
	get keyRefused(): boolean {
		return this.status === 401 || this.status === 403;
	}
}

interface OpenAIErrorBody {
	error?: { message?: string; code?: string | null; type?: string };
}

async function call(key: string, path: string, init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number }): Promise<unknown> {
	let res: Response;
	try {
		res = await fetch(`${openaiBase()}${path}`, {
			method: init.method,
			headers: { Authorization: `Bearer ${key}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
			signal: AbortSignal.timeout(init.timeoutMs),
		});
	} catch (err) {
		throw new OpenAIError(0, `Could not reach OpenAI: ${err instanceof Error ? err.message : String(err)}`, "unreachable");
	}
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = null;
	}
	if (!res.ok) {
		const error = (body as OpenAIErrorBody | null)?.error;
		throw new OpenAIError(res.status, error?.message || `OpenAI answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`, error?.code || error?.type || "");
	}
	return body;
}

interface ResponsesBody {
	output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
}

/**
 * Step 1: the art director's image prompt for a page (`brief`, its visible
 * content). `earlier`: prompts it wrote before for this cover, which the
 * new one must differ from (New idea).
 */
export async function writeCoverPrompt(key: string, brief: string, earlier: string[] = []): Promise<string> {
	const input = earlier.length === 0 ? brief : `${brief}\n\nEarlier ideas for this cover - write a clearly different take in the same house style (another subject, crop or palette):\n${earlier.map((p) => `- ${p}`).join("\n")}`;
	const body = (await call(key, "/v1/responses", {
		method: "POST",
		body: { model: ART_DIRECTOR_MODEL, instructions: ART_DIRECTOR_INSTRUCTIONS, input, reasoning: { effort: "low" }, store: false },
		timeoutMs: TEXT_TIMEOUT_MS,
	})) as ResponsesBody | null;
	const parts = (body?.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
	const refusal = parts.find((p) => p.type === "refusal")?.refusal;
	const text = parts.filter((p) => p.type === "output_text").map((p) => p.text ?? "").join("").trim();
	if (!text) throw new OpenAIError(200, refusal ? `OpenAI declined to write a cover idea: ${refusal}` : "OpenAI wrote no cover idea.", refusal ? "refusal" : "empty");
	return text.replace(/^["“]+|["”]+$/g, "").trim();
}

interface ImagesBody {
	data?: Array<{ b64_json?: string }>;
}

/** Step 2: paint `prompt` as a cover; the JPEG's bytes. */
export async function paintCover(key: string, prompt: string): Promise<Uint8Array> {
	const body = (await call(key, "/v1/images/generations", {
		method: "POST",
		body: { model: IMAGE_MODEL, prompt: `${prompt}\n\n${COVER_STYLE}`, n: 1, size: COVER_SIZE, quality: IMAGE_QUALITY, output_format: IMAGE_FORMAT },
		timeoutMs: IMAGE_TIMEOUT_MS,
	})) as ImagesBody | null;
	const b64 = body?.data?.[0]?.b64_json;
	if (!b64) throw new OpenAIError(200, "OpenAI returned no image.", "empty");
	return new Uint8Array(Buffer.from(b64, "base64"));
}

// ── Refused keys ─────────────────────────────────────────────────

/** Keys OpenAI refused, by credential id: a hash of the key (never the key) and OpenAI's message. */
const refusals = new Map<string, { key: string; message: string }>();

/** OpenAI refused this credential's key: its Error says so until the key changes or a Check passes. */
export function noteKeyRefused(credentialId: string, key: string, message: string): void {
	refusals.set(credentialId, { key: Bun.hash(key).toString(16), message });
}

/** OpenAI's message for this credential's current key, when it refused that key; "" otherwise. */
export function keyRefusal(credentialId: string, key: string): string {
	const r = refusals.get(credentialId);
	return r && r.key === Bun.hash(key).toString(16) ? r.message : "";
}

/**
 * A Check of the credential's key: OpenAI's message when it refuses the key
 * (remembered), "" when it works (any earlier refusal forgotten). A network
 * failure throws: nothing was learned about the key.
 */
export async function checkCredentialKey(credentialId: string, key: string): Promise<string> {
	try {
		await call(key, "/v1/models", { method: "GET", timeoutMs: TEXT_TIMEOUT_MS });
	} catch (err) {
		if (!(err instanceof OpenAIError) || !err.keyRefused) throw err;
		noteKeyRefused(credentialId, key, err.message);
		return err.message;
	}
	refusals.delete(credentialId);
	return "";
}
