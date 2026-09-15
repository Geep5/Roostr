# Roostr

Anytype-style notes on the **glon** substrate, built on Odin + Svelte:
a native backend serving a content-addressed protobuf Change-DAG, with
the block editor / queries / channels / discussions SPA as a pure
client. Nostr-ready: your key is your identity, sync rides relays.

(Formerly "glonOdin" — the TS reference implementation lives in
`projekt/3/glon`.)

Native and browser builds use the same Odin domain engine. Raw
`~/.glon/changes/<objectId>/<hex>.pb` bytes remain authoritative; legacy
content addresses are verified over their original bytes, not a re-encoding.

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
client of the Odin server. Agents are `agent` objects; their conversation
is the object's discussion (chat blocks + tool_use/tool_result/compaction
blocks under `__discussion__`), so the Roostr UI is the chat surface.

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

Recurring objects: the engine owns the rule (`repeat` field: `next`,
`fired_for`, …) and the harness is the clock. `serve` arms one timer for
the earliest unfired occurrence across the spaces this machine serves,
re-arming on every `repeat` or `served_by` commit. When it fires it
commits `occurrence_fire` (refused if another writer got there first), then
either frames the object's body into the assigned agent's chat
(`assignee`/`agent` naming an agent served here) and runs one turn -
recorded on the object with `run_record` - or, for a person's object,
posts a one-line reminder on its discussion. Agents finish with the
`occurrence_complete` tool; a recurring object is never `done`. Missed
occurrences (sleep, downtime) fire once on the next start. To keep it
running, see `harness/launchd/`.
