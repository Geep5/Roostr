import type { Roostr } from "../tool-sdk";

export const description =
	"Read and update Shortcut (app.shortcut.com) through YOUR Shortcut credential (a Shortcut credential in your Credentials; the harness sends its API token, you never see it). One call is one request to Shortcut's REST API v3: `path` is the part after https://api.app.shortcut.com/api/v3, with its query string. " +
	"Reads: GET /search/stories?query=<Shortcut search, e.g. owner:josh state:\"Ready for Deploy\" or \"paypal\" is:started>&page_size=25&detail=slim (search also /search/epics, /search/iterations; follow the answer's `next` for more), GET /stories/<id>, GET /epics, GET /epics/<id>/stories, GET /iterations, GET /iterations/<id>/stories, GET /workflows (each state's id and name), GET /members (people's ids, names, mention names), GET /groups (teams), GET /labels. " +
	"Writes (only when the task asks for them): POST /stories {name, description, workflow_state_id or project/group, story_type feature|bug|chore, owner_ids, epic_id, iteration_id, labels:[{name}]}, PUT /stories/<id> with only the fields to change (workflow_state_id to move it, owner_ids, estimate, deadline...), POST /stories/<id>/comments {text}. Never DELETE unless a person explicitly asks. " +
	"Use names from GET /workflows and /members to turn ids into words, and link a story by its `app_url`. Only report done what the answer confirms.";
export const inputs =
	"path: string - path and query on the v3 API, starting with /, e.g. /search/stories?query=state:started&page_size=25&detail=slim\nmethod?: GET|POST|PUT|DELETE - default GET\nbody?: object - the JSON body for POST and PUT";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const path = typeof input.path === "string" ? input.path.trim() : "";
	if (!path.startsWith("/")) return "error: pass `path`, the part after https://api.app.shortcut.com/api/v3, starting with / (e.g. /stories/123)";
	const method = typeof input.method === "string" && input.method.trim() ? input.method.trim().toUpperCase() : "GET";
	if (!["GET", "POST", "PUT", "DELETE"].includes(method)) return `error: method must be GET, POST, PUT or DELETE, not ${method}`;
	// Models sometimes send the body JSON-encoded: read both.
	let body: unknown = input.body;
	if (typeof body === "string" && body.trim()) {
		try {
			body = JSON.parse(body);
		} catch {
			return "error: `body` must be a JSON object";
		}
	}
	if ((method === "POST" || method === "PUT") && (typeof body !== "object" || body === null)) return `error: a ${method} needs a JSON object in \`body\``;
	// Having the credential is the permission: the harness refuses an agent whose Credentials list no Shortcut one.
	const answer = await roostr.credentials.api("shortcut", path, { method, body: method === "POST" || method === "PUT" ? body : undefined });
	if (!answer.ok) return answer.signedOut ? `Credential unavailable: ${answer.error} Tell the person; do not retry this turn.` : `error: ${answer.error}`;
	// The harness keeps 256 KB of a tool's answer: cut here and say so, so the model narrows instead of reading a torn JSON.
	const text = JSON.stringify(answer.body, null, 1);
	const budget = 200_000;
	return text.length <= budget ? text : `${text.slice(0, budget)}\n[cut: ${text.length - budget} more characters - ask for fewer (page_size, detail=slim) or one item]`;
}
