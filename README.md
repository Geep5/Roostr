# Roostr

A local-first workspace where every object has its own agent.

Notes, tasks, people, projects: each is an object in a content-addressed
protobuf Change-DAG, each object carries a mailbox, and any of them can
be served by an agent. You talk to a thing where it lives — one object,
or several gathered into a group exchange — and the answer lands in that
object's own history. Agents run on machines you pair explicitly, ask a
paired human before they act on any capability, and never see a
credential: passwords, keys and tokens stay on the machine that approved
them.

The substrate is **glon**, built on Odin + Svelte: a native backend
serving the Change-DAG, with the object editor / queries / channels /
discussions SPA as a pure client. Your Nostr key is your identity, sync
rides relays. Native and browser builds run the same Odin domain engine —
the browser gets it as WebAssembly, so the web view works offline with a
durable outbox and no account at all.

## Run

```bash
odin build src -out:glon-odin -o:speed
./glon-odin serve            # API on http://127.0.0.1:7333 (GLON_DATA=~/.glon)
./glon-odin list             # object summaries
./glon-odin dump <objectId>  # computed state as JSON (parity testing)

# In separate terminals; sync does not require an agent harness:
cd harness && bun install && bun run sync
cd harness && bun run serve        # optional: agents and machine integrations

# The single UI source is the sibling RoostrWebsite repository:
cd ../RoostrWebsite && npm install && npm run dev:local
# Open http://127.0.0.1:5190/app and pair with the code in the daemon terminal.
```

### Toolchain

Engine artifacts are built with **Odin `dev-2026-07`** (`odin version` →
`dev-2026-07:819fdc7a8`, Homebrew `odin` 2026-07a). Both build scripts record
the compiler in their manifests (`RoostrWebsite/static/engine-core.json`,
`RoostrIOS/Vendor/glon-core.json`); a different compiler produces different
artifact hashes, so rebuild and commit the artifacts from the pinned version
or bump this line together with them. Tagged releases carry the same
fingerprints in their notes.

## Layout

```
core/          shared Odin protobuf codec, replay, query, mutation planning,
               NIP-44 v2, relay wire helpers, the shared-space authority gate,
               and the receive-side sync session (reassembly, cursor, replay groups)
abi/           bounded byte/JSON request ABI shared by every host build
wasm/          browser entry (js_wasm32) for the abi
native/        static-library entry (core_init) for Swift/C hosts
build-wasm.mjs emits RoostrWebsite/static/engine.wasm plus source/hash manifest
build-xcframework.mjs
               emits RoostrIOS/Vendor/Glon.xcframework (iOS, simulator, macOS) plus manifest
src/           native disk store, authenticated HTTP/SSE, identity and key files
harness/       Bun services: independent Nostr sync; optional agent/tool harness
../RoostrWebsite/
               canonical Svelte UI, paired-native and browser-offline backends
               (no mirrored UI source in this repository)
../RoostrIOS/  Swift host: GlonCore actor over the xcframework, SwiftUI shell
```

## API

All data APIs require `Authorization: Bearer …`. Local services read the
mode-0600 `GLON_DATA/api-token`; never give that service token to a webpage.
Browsers pair explicitly using a one-use five-minute key. The daemon prints it
at startup and exposes it to loopback UIs plus the exact Roostr production
origins, so **This machine** can surface it without granting arbitrary websites
local access. Pairing creates an Origin-bound UI session that expires in 24
hours and persists across daemon restarts. Public `/api/pair/status` never
returns a pairing key. Authenticated fetch streaming carries SSE authorization;
tokens are not URLs. Run `bun run pair` from `harness/` to rotate the key without
restarting the daemon or disconnecting already-paired tabs.
UI sessions cannot export the native private key. An operator can explicitly run
`./glon-odin key-export` in a private terminal for recovery; do not log/share it.

```
GET  /api/objects            object summaries
GET  /api/objects/{id}       computed object state
GET  /api/relations          relation definitions
GET  /api/channels           channels (spaces) with pins + members
POST /api/query              {filters, sorts, textQuery, setId, type, limit, offset}
POST /api/mutate             {action, ...} — create, block_add/update/move/remove,
                             block_set_attrs, set_field, delete, channel_*
GET  /api/events             SSE: {"objectId"} per committed change
```

## For external machines (bots outside Roostr)

A local agent that lives *outside* Roostr (a Discord bot, a CLI, a cron job)
works the same way a Roostr agent does: it manipulates objects and, if it wants
an agent to answer, configures one through properties. This is the contract.

### The object model

Everything is an object in a content-addressed Change-DAG, space-scoped.
Types: `note`, `task`, `person`, `agent`, `capability`, `install`, `machine`,
`system_prompt`, `channel` (a space). Objects carry typed **properties**; the
same properties you set in the UI are the ones you set through the API.

Read and write against the daemon (auth: `Authorization: Bearer <GLON_DATA/api-token>`):

```bash
# Query objects
curl -X POST http://127.0.0.1:7333/api/query -H "Authorization: Bearer $TOK" \
  -d '{"type":"task","filters":[{"key":"channel","condition":"equal","value":"<spaceId>"}]}'

# Read one object (full state: fields, blocks, mailbox)
curl http://127.0.0.1:7333/api/objects/<objectId> -H "Authorization: Bearer $TOK"

# Write a property
curl -X POST http://127.0.0.1:7333/api/mutate -H "Authorization: Bearer $TOK" \
  -d '{"action":"set_field","object_id":"<objectId>","key":"status","value":{"stringValue":"In progress"}}'

# Create an object
curl -X POST http://127.0.0.1:7333/api/mutate -H "Authorization: Bearer $TOK" \
  -d '{"action":"create","name":"My task","type_key":"task","fields":{"channel":{"stringValue":"<spaceId>"}}}'

# Watch changes (SSE, one {"objectId"} per commit)
curl http://127.0.0.1:7333/api/events -H "Authorization: Bearer $TOK"
```

### Configuring an agent through properties

An agent is a blank object you configure by setting its properties — the same
properties you'd click in the UI. There is no setup wizard and no `kind` field.

- **`served_by`** (link → `machine` object): the computer it runs on.
- **`prompt`** (link → `system_prompt` object): its configuration (standing
  prompt, model, requires, skills). Edit or point at a different prompt object.
- **`model`**, **`responsible_types`** (text/tag): per-agent overrides.
- **`requires`** (links → `capability` objects): what the machine must provide.
- **`install`** (links → `install` objects): credentials it authenticates with.

To make a working agent: create the object, set `served_by` to a machine, set
`prompt` to a `system_prompt` object, then enable it on that machine's roster:

```bash
curl -X POST http://127.0.0.1:7334/agents/toggle -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" -d '{"id":"<agentId>","enabled":true}'
```

To address an agent: `POST /api/mutate` `chat_post` with `@<AgentName>` in the
text on the object's `__discussion__` thread. A mention is the wake signal;
nothing answers uninvited. The reply lands in the same thread.

### Verifying an agent is working

On the machine's harness (`:7334`, same bearer token):

```bash
# This machine's id and host
curl http://127.0.0.1:7334/machine -H "Authorization: Bearer $TOK"

# Every agent on the roster and which are currently served here
curl http://127.0.0.1:7334/agents -H "Authorization: Bearer $TOK"
# → { roster: [ids], serving: [ids currently answering] }

# Live turn state: idle / working / error, with the surface and detail
curl http://127.0.0.1:7334/agent/status -H "Authorization: Bearer $TOK"
# → { agents: [{ id, name, icon, state, surface, detail, ts }] }
```

An agent is working when it is in `serving`, its state is `idle` or `working`
(not `error`), and a `chat_post` with its `@Name` on a configured object gets a
reply in `__discussion__`. An `error` state carries the reason (a missing
capability, a credential that needs approval). Capability and credential
requests that need a human are under `GET /capability-requests`; a paired human
approves them (they never run on receipt).

## Verified

- Native/WASM codec, replay, query, mutation and wire fixtures are in `core/` and
  `query_tests/`, with browser runners under `RoostrWebsite/scripts/` and Swift
  runners under `RoostrIOS/Tests/`. `core/nip44_vectors.json` is the official
  NIP-44 vector set; `core/wire_fixtures.json` was produced by the TypeScript
  reference so the engine is held to the bytes already on the relays.
- `odin test core`, `odin test query_tests`, and `odin test src` exercise domain
  and local authorization contracts. Browser tests cover pairing, shared-space
  authority, chunk bounds, durable outbox and ABI lifetime.
- `RoostrWebsite/scripts/parity-replay.ts` verifies raw stored hashes and compares
  all local objects against the daemon; it must use authenticated requests when
  run against the protected daemon.

## Known deviations

- Replay serializes each block id once: trees with repeated child refs (legacy
  imports, diamonds) no longer emit the block per reference — chained duplicates
  used to expand 2^N and wedge boot. The website TS engine and the shared
  `core/replay_fixtures.json` corpus must be updated together when they resync.
- Native/browser date quickOption windows use the same UTC boundaries.
- SSE observes writes through the daemon. Do not run the legacy TypeScript
  bootstrap against a production data root; it recreates obsolete code objects.

## Sync (nostr)

Relays transport encrypted changes; local `.pb` files remain canonical.
`bun run sync` in `harness/` runs synchronization independently of agent work.
Startup reconciles local history with relay history; merely wiping the relay
does not reset the dataset. Permanent deletion uses the synced `__vanished__`
ledger plus acknowledged NIP-09 cleanup, not manual file removal.

Shared imports carry verified outer signer, source space and key version to the
native importer. Both engines check target scope and owner-only operations;
knowing one shared-space key is not authority over another space or its members.
Browser edits enter a durable outbox before publication, and logout refuses
unpublished work unless it is explicitly exported.

Serving is per object (`docs/object-serving.md`): the engine's resolver
(`core/serving.odin`) picks the machine from the object's `served_by` pin,
its `requires` capabilities against each machine object's published
`capabilities`, then the space's `served_by` default. No heartbeats or
leases - only the serving machine sets its own verified checkout path.

## Harness (`harness/`)

The holdfast agent harness, ported as a Bun sidecar that is a pure HTTP
client of the Odin server. Agents are `agent` objects. Direct human discussion
and local tool/compaction history remain under `__discussion__`; messages
between objects use their individual mailboxes, not a shared conversation.

```bash
cd harness && bun install
bun run src/index.ts setup --name Gracie          # create the agent object
bun run src/index.ts serve                        # SSE daemon: replies to chats
bun run sync                                     # independent notes transport
bun run src/index.ts ask <agentId> "message"      # one-shot turn
```

Credentials (Settings → Agent in the app, served by the harness on
:7334): "Sign in with Claude" runs the Authorization-Code+PKCE flow
against your Pro/Max plan (port of glon auth.ts — claude.ai authorize,
paste-back code, token exchange + auto-refresh into `~/.glon/auth.json`,
0600). Fallbacks: pasted API key → `ANTHROPIC_API_KEY` env → Claude Code
keychain token. Model `mock` runs the full loop offline for smoke tests.

Ported from glon's holdfast with the OMP lifts: view-only tool-output
pruning before compaction, usage-calibrated token estimator, touched-object
carryover across stacked summaries, and progressive-disclosure skills
(`skill` objects listed by description, bodies read on demand) plus
per-channel `instructions` objects. Memory is `pinned_fact`/`milestone`
objects with owner scoping, keyed upserts, supersession, and an opt-in
compaction-time extraction loop (`memory_extraction_enabled`); digest
injection via `memory_digest_enabled`.

### Object mailboxes

`AgentMessage` in `glon.proto` is the canonical message envelope: stable message
and exchange IDs, sender object/agent, explicit recipients, reply reference,
text, timestamp, and optional capability operation. The envelope is stored in
each participating object's Change-DAG. An exchange ID groups the UI; it is not
a separate authoritative conversation object.

The sender commits an outbox entry first. Delivery commits the same envelope
to each recipient's inbox before acknowledging that recipient on the sender.
Duplicate delivery is idempotent; pending delivery survives restart. Delivery
and processing are separate: "delivered" means in the inbox, not that a tool
ran. The object's serving harness claims processing; interrupted work is
reported as failed and requires explicit retry rather than silently replaying
side effects.

Group messages name every recipient. Replies fan out to the original audience;
private replies start a separate exchange. Replies do not automatically request
another response, avoiding agent reply loops. Existing exchanges migrate as
historical messages and never run again merely because they were imported.

Capability requests address the installation object owned by the relevant
machine. Install, enable, disable, uninstall, login, credential save/check/revoke
all use this message path. Receiving or syncing a request never starts an
installation or login: **This machine → Capability requests** requires a paired
human's approval. Passwords, API keys, cookies and OAuth tokens remain local;
only requests, safe status and results enter object history.

### Recurring objects

Recurring objects: the engine owns the rule (`repeat` field: `next`,
`fired_for`, …) and the harness is the clock. `serve` arms one timer for
the earliest unfired occurrence across the spaces this machine serves,
re-arming on every `repeat` or `served_by` commit. When it fires it
commits `occurrence_fire` (refused if another writer got there first), then
either frames the object's body into the assigned agent's chat
(`assignee`/`agent` naming an agent served here) and runs one turn -
recorded on the object with `run_record` - or falls back to the machine
serving the object: that machine's default agent for the space. A person's
object still posts a one-line reminder on its discussion. Agents finish
with the `occurrence_complete` tool; a recurring object is never `done`. Missed
occurrences (sleep, downtime) fire once on the next start. To keep it
running, see `harness/launchd/`.
