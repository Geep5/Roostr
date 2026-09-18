# Durable state: what is actually at risk, and what a DB fixes

Status: proposed. Audit of the reliability and scale limits, and the plan.
Supersedes the pruning half of `docs/storage-compaction.md`.

## The concern, restated

"State in memory is a liability for a decentralized system — if a process dies
we should not lose anything, and a massive space should still be queryable."

Both halves are right, but they are **different problems in different layers**,
and only one of them is a data-loss risk today.

## Layer 1 — the change log (canonical). Real bug, cheap fix.

The log on disk is the source of truth and what relays speak. It is not in
memory. But two defects make it less of a rock than it looks:

**Writes are neither atomic nor durable** (`src/store.odin:191`):

```odin
if os.write_entire_file(path, full) != nil do return "", false
```

No temp file, no rename, no `os.sync`. A crash or power cut mid-write leaves a
**truncated file sitting at its final content-addressed path**, and the write is
only in the page cache until the OS decides otherwise. The relay already does
this correctly — `write_record_to` + `os.sync(g_fd)` (`relay/src/store.odin:102`).

**Loads never verify the address** (`src/store.odin:148-153`):

```odin
data, rerr := os.read_entire_file(f.fullpath, alloc)
if rerr != nil do continue
c, cok := core.decode_change(data, alloc)
if cok do append(&changes, c)
```

The filename *is* the sha256 of the change, and nothing checks it. So a
truncated-but-decodable file is accepted as genuine — exactly the corruption
content addressing exists to make impossible — and an undecodable one is skipped
in silence: no error, no log line, no repair, the change simply disappears.

### Fix (do this first, it is small)

1. Write `<hex>.pb.tmp`, `fsync` the file, `rename` into place, `fsync` the
   directory. A rename is atomic, so a reader sees all or nothing.
2. On load, recompute `sha256(encode_change(c, for_hashing = true))` and compare
   with the filename. On mismatch: move to `changes/.quarantine/`, log loudly,
   and let sync re-fetch the change from a relay (it is content-addressed, so a
   good copy is recoverable from any peer).
3. Count skipped/quarantined changes in the store and expose the number —
   silent loss is the part that makes a system feel unreliable.

This is the whole of the actual data-loss exposure. Everything below is scale
and recovery time, not loss.

## Layer 2 — derived state (in memory). Real ceiling, measured.

`g_store.states` holds every computed object in an arena
(`src/store.odin:38-39`), and the browser holds the same set in a `Map`. Nothing
is *lost* when that dies — it is rebuilt by replay — but it costs:

| limit | measured |
| --- | --- |
| daemon boot | replays all **12,480** changes |
| browser cold start | full relay walk, ~97 pages × 128 events (~11.5 s CPU here, several × that on a phone) |
| view query at 1,000 objects | 2 ms |
| view query at 20,000 objects | 26 ms (9.3 MB serialized into the core per query) |
| view query at 50,000 objects | **traps the WASM core** |
| view query at 100,000 objects | **rejected: "Core request exceeds 16 MiB"** |

Every view render serializes the entire object set into the engine. So a
"massive space" is capped at roughly 30k objects by construction, and recovery
is O(history) rather than O(1).

That is the case for a persisted, indexed read model.

## Which database

The workload is: many small writes (one change per edit), point reads, and
filtered/sorted/paginated list views plus text search.

| | SQLite | DuckDB |
| --- | --- | --- |
| shape | row store + B-tree indexes | columnar, vectorized |
| built for | many small transactions, point/range reads | bulk analytical scans |
| our views (filter/sort/paginate) | ideal | works, wasted strengths |
| per-edit writes | ideal (WAL) | weak — built for bulk load |
| text search | FTS5 built in | none |
| browser/WASM payload | **3 MB** (`@sqlite.org/sqlite-wasm`) | **149 MB** unpacked (`@duckdb/duckdb-wasm`) |
| iOS | ships with the OS | extra C++ dependency |
| analytics (group/aggregate over millions) | mediocre | excellent |

For the read model: **SQLite**. The phone is the binding constraint and it is
already struggling with a 12k-event bootstrap; a 149 MB engine bundle is not an
option there, and DuckDB's strengths (aggregate scans) are not what a view does.

For analytics: **DuckDB, as an optional sidecar on desktop**. It reads SQLite
files and Parquet directly, so "count sponsors per month across 2M objects" can
attach to the same data without becoming a dependency of the app. This keeps
DuckDB exactly where it wins and off the critical path.

## Architecture

```
relays  ─── changes (content-addressed, append-only)  ← canonical, syncable
              │
              ├─ changes/<objectId>.glog      durable log (atomic + fsync)
              │
              └─ state.sqlite                 derived, persisted read model
                    objects(id, type_key, space, created_at, updated_at, deleted)
                    fields(object_id, key, kind, text, num, bool, json)
                    blocks(object_id, id, parent, idx, content_type, text)
                    fts(objects: name, text)
                    meta(cursor, schema_version, replayed_through)
```

Rules that keep it honest:

- **The DB is never the source of truth.** It is a projection that can be
  dropped and rebuilt from the log. A decentralized system cannot sync a
  database; it syncs changes. (Same rule the format already states for
  snapshots: "never source of truth — a replay optimization".)
- **One write path.** Applying a change writes the log frame and the DB rows in
  one transaction, with `meta.replayed_through` advanced in the same commit. On
  boot, if `replayed_through` is behind the log, replay only the tail.
- **One query semantics.** Views compile to SQL in the shared core (Odin), which
  every host executes against its own SQLite. Two hand-written query
  implementations is precisely the divergence that produced this session's
  daemon-vs-browser bugs; do not reintroduce it in SQL.
- **Recovery is opening a file**, not replaying history: crash, power cut, or
  kill -9 costs the tail since the last commit, which the log still holds.

## Phases

1. **Harden the log** (atomic + fsync + verify-on-load + quarantine counter).
   No schema change, no new dependency, removes the only true loss path.
2. **Consolidate files**: per-object `.glog` (861 files instead of 12,480; ~49 MB
   of block waste → ~5 MB). From `docs/storage-compaction.md`, minus pruning —
   history stays, it costs 4.79 MB.
3. **Introduce `state.sqlite`** as a pure projection, written alongside the
   existing in-memory map. Ship it dark: compare every query's SQL result with
   the in-memory engine's result over the real 855-object vault until they agree
   exactly.
4. **Cut over reads** to SQL, keep the in-memory map only as a cache for hot
   objects. The 16 MiB serialize ceiling disappears; views paginate in SQL.
5. **Browser/iOS**: same schema over `sqlite-wasm` + OPFS, so a phone opens a
   file instead of replaying 12k events. Pairs with the `SpaceBundle` bootstrap.
6. **Optional**: DuckDB attaches to the SQLite file on desktop for analytics.

## Verification

- Crash test: kill the daemon mid-write in a loop; every surviving object must
  replay clean, and every quarantined file must be re-fetchable from the relay.
- Parity runner: for all 855 objects and every saved view in the real vault, SQL
  results equal current engine results (ordering included).
- Scale test: 200k synthetic objects — view query stays sub-100 ms and boot stays
  O(tail), where today 50k traps the core.
- Rebuild test: delete `state.sqlite`, rebuild from the log, byte-identical
  projection.
