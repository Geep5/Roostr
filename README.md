# Roostr

Anytype-style notes on the **glon** substrate, built on Odin + Svelte:
a native backend serving a content-addressed protobuf Change-DAG, with
the block editor / queries / channels / discussions SPA as a pure
client. Nostr-ready: your key is your identity, sync rides relays.

(Formerly "glonOdin" — the TS reference implementation lives in
`projekt/3/glon`.)

Both stacks read and write the same `~/.glon/changes/<objectId>/<hex>.pb`
files — content addresses verify across implementations
(`sha256(proto3-encode(change with zeroed id))`, protobufjs-compatible).

## Run

```bash
odin build src -out:glon-odin -o:speed
./glon-odin serve            # API on http://127.0.0.1:7333 (GLON_DATA=~/.glon)
./glon-odin list             # object summaries
./glon-odin dump <objectId>  # computed state as JSON (parity testing)

cd app && npm install && npm run dev   # SPA on http://localhost:5190
```

## Layout

```
src/
  proto.odin   protobuf wire codec (decode anything protobufjs wrote;
               encode proto3-default-omitting for stable hashes)
  dag.odin     Kahn toposort + Anytype-style block tree ops
               (insertTo/moveFromSide, deterministic layout ids) +
               normalize pass + state computation
  query.odin   filter/sort engine (17 conditions, and/or nesting,
               date quickOptions, hierarchical sorts)
  store.odin   disk scan → per-generation arena state cache; writes
               content-addressed changes
  server.odin  HTTP/1.1 over core:net — JSON API + SSE broadcast
  mutate.odin  /api/mutate actions, bundled-relation bootstrap,
               channel keys (channel-keys.json) + invite payloads
  main.odin    serve | list | dump
app/           SvelteKit SPA (adapter-static, ssr=false), talks to
               VITE_GLON_API (default http://127.0.0.1:7333)
```

## API

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

- 269/269 real objects replay identically in Odin vs the TS engine
  (blocks, marks, layouts, fields, tombstones).
- Content addresses of Odin-written changes verify in the TS stack and
  vice versa.
- Browser end-to-end: editor typing/split/marks/drag-to-column, block
  menu, queries with stored filters/sorts, channels + pins.

## Known deviations

- Date quickOption windows use UTC day boundaries (TS used local time).
- SSE only observes changes written through this server (no fs watch);
  external writers need a manual refresh.
