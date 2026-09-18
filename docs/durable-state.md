# Durable state and query scale, without a database

Status: layer 1 done, layer 2 partly done. Decision: **stay homebrew.** No
SQLite, no DuckDB — the format stays ours and there is exactly one query
implementation across daemon, browser and iOS.

## The concern, restated

"State in memory is a liability for a decentralized system — if a process dies
we should not lose anything, and a massive space should still be queryable."

Both halves are right, but they are **different problems in different layers**,
and only one of them was ever a data-loss risk.

## Layer 1 — the change log (canonical). Fixed.

The log on disk is the source of truth and what relays speak; it was never in
memory. Two defects made it less of a rock than it looked:

- **Writes were neither atomic nor durable**: `os.write_entire_file` straight
  to the final content-addressed path, no temp file, no rename, no `fsync`. A
  crash could leave a truncated file at a name claiming to be the hash of its
  contents, and an acknowledged write could still be lost in the page cache.
- **Loads never verified the address.** The filename *is* the sha256, and
  nothing compared them, so a torn-but-decodable change replayed as genuine
  and an undecodable one was skipped in silence.

Both are fixed (`src/store.odin`): temp → `fsync` → `rename` → `fsync` the
directory, the address is recomputed on load, and a mismatch is parked in
`changes/.quarantine/<objectId>/` and counted in `/api/settings`
(`quarantinedChanges`) so loss can never be silent. Verified against a copy of
the real vault first: 861 objects loaded, 9 of 12,480 changes quarantined,
zero false positives — all 9 also fail to decode in the TypeScript codec.

## Layer 2 — query scale. Two defects fixed, one ceiling measured.

The core already keeps queried objects resident (`QUERY_CACHE_MAX_OBJECTS ::
100_000`) and accepts `{ upserts, removed, reset }`, so a query should only
carry what changed. Two things spoiled that, both in the host:

1. **A cold start pushed the whole vault in one request** — anything past the
   ABI's 16 MiB reservation was rejected outright, so a large space could not
   be queried at all on first load. Fixed: the push is split into batches that
   each fit the reservation (`PUSH_BUDGET_BYTES`), with `reset`/removals on the
   first batch only.
2. **Every query re-serialized the entire corpus** to diff signatures, so a
   view render was O(corpus) even when nothing had moved. Fixed: the backend
   records upserts/removals where it actually mutates state (`ensure`,
   `enforceVanished`) and passes that delta; the signature diff remains as the
   fallback for callers without change tracking.

Measured on this machine, fresh process per row:

| vault | cold first query | warm query after one edit |
| --- | --- | --- |
| 10,000 objects / 8.3 MB | 303 ms | **6.6 ms** |
| 20,000 objects / 16.6 MB | 609 ms | **15.1 ms** |

The warm path is what a view render costs now; before, it was the cold number
every single time.

### The ceiling that remains

The core's query arena is `QUERY_CACHE_MAX_BYTES :: 128 * 1024 * 1024`, and it
is consumed several times faster than payload because every parsed allocation
carries its own header. Measured limits:

| payload | result |
| --- | --- |
| 16.6 MB | works |
| 20.4 MB | `query cache memory limit exceeded` |
| 24.8 MB | `query cache memory limit exceeded` |

So a space tops out around **20 MB of object JSON** — roughly 4× the current
vault (4.79 MB). Two honest options when that becomes real, in this order:

1. **Cut arena overhead per object.** The cache reparses each object's JSON
   into a region with a header per allocation. Fewer, larger allocations (or
   decoding straight from the wire bytes) buys multiples without raising the
   budget.
2. **Raise the budget.** One constant, linear effect — but it is WASM memory,
   and the phone is the binding constraint, so this is the second lever.

Neither needs a database. What a database would have bought — an indexed store
that queries without holding the corpus — is the same work as (1), minus a
dependency and minus a second query implementation. Two hand-written query
engines is exactly the divergence that produced the daemon-vs-browser bugs this
audit started from.

## What is NOT being done, and why

- **No SQLite, no DuckDB.** The canonical format is the change log; a
  decentralized system syncs changes, not databases. Any engine would be a
  derived projection, and a projection is only worth its weight once (1) above
  is exhausted.
- **No file consolidation as separate work.** Collapsing 12,480 per-change
  files into 861 per-object logs is only worth doing as part of a format change
  (log + snapshots), not as interim churn ahead of one.

## Still available, unused

`ObjectSnapshot` exists in the wire format (`glon.proto:245`) with `fields`
**and** `blocks` — an object and its chat in one message — and `compute_state`
already starts replay from the newest snapshot (`core/dag.odin:548`). Nothing
writes one. When boot time or file count becomes the complaint, that is the
lever, and it is already designed.
