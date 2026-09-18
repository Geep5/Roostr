# One protobuf per object, diffs on the wire

Status: proposed. Research plus plan for collapsing the per-change file store
into per-object logs with snapshots.

## Measured today

`~/.glon/changes` on the Mac holding the real vault:

| metric | value |
| --- | --- |
| objects (directories) | 861 |
| changes (`.pb` files) | 12,480 |
| actual payload | **4.8 MB** |
| space consumed on disk | **~49 MB** |
| top 10 objects | 28% of all bytes |
| objects with >100 changes | 21, holding 34% of bytes and 4,927 changes |

The payload is small; the **file count** is the cost. Each change is a few
hundred bytes in its own file, so a 4 KB filesystem block per change inflates
4.8 MB into ~49 MB and 12,480 inodes. Boot, backup, and any directory walk pay
per file, not per byte.

So the goal is not compression. It is: fewer files, a short replay, and a
bootstrap that does not re-walk history.

## What the format already supports

- `ObjectSnapshot` exists (`glon.proto:245`): `fields`, **`blocks`**, `deleted`,
  `created_at`, `updated_at`. Because chat messages are blocks, a snapshot is
  already "the object *and* its chat in one protobuf".
- `Change.snapshot` is field 7, documented as "never source of truth — a replay
  optimization".
- Replay already honours it: `compute_state` picks the newest snapshot by
  timestamp and starts the op replay after it (`core/dag.odin:548-570`).
- Authority already validates snapshots: they may not change an object's type,
  hide protected fields, or escape their space (`core/authority.odin:125-141`).

**Nothing writes one.** The capability is complete and unused — no producer in
`core/mutate.odin`, `src/mutate.odin`, or the harness.

## Plan

### 1. Per-object append-only log

Replace `changes/<objectId>/<hex>.pb` with `changes/<objectId>.glog`: framed
records (varint length + change bytes + CRC32), appended under the same lock the
store already takes. 861 files instead of 12,480.

The frame is a container, not a new truth: each record still content-addresses
to its own id, so the DAG, verification, and relay format are untouched. The
relay's own log (`relay/src/store.odin`) already uses this framing — same shape,
same recovery rules (a torn tail truncates to the last good frame).

### 2. Snapshot + prune ("1 protobuf per object")

When a log passes a threshold — start with >48 changes or >64 KB — append one
change carrying `ObjectSnapshot` of the computed state, then drop the frames it
supersedes, keeping the head chain intact.

Two hard rules:

- **Never prune above the published cursor.** A change that has not yet reached
  the relays must survive; prune only what sync has confirmed published
  (`sync-state.json` `published`).
- **Never prune another writer's tail.** In a shared space, keep frames whose
  author is not us until they are covered by a snapshot we are allowed to write
  (authority: only the owner may snapshot control objects).

On this vault that collapses the 21 hot objects (4,927 changes, 34% of bytes)
into 21 snapshots plus short tails. Superseded ops disappear — 520 changes on
one agent chat become one snapshot of the current blocks.

### 3. Bootstrap bundle (the fix for slow first loads)

A new device today walks the whole relay history: ~97 pages of 128 events,
measured at 0.55 ms/event just to verify signatures, plus 0.30 ms to ingest —
about 11.5 s of CPU on an M3 Ultra and several times that on a phone.

Add a `SpaceBundle`: the newest snapshot per object plus the cursor they cover,
served by the daemon (a new `/api/bundle`) or by any peer. A fresh device then:

1. fetches the bundle (one request, one protobuf),
2. subscribes from `bundle.cursor + 1` for the diffs,
3. falls back to the full walk if the bundle is unavailable or fails validation.

The bundle is cacheable and verifiable — every snapshot inside is a normal
signed change — so it is an optimization, never an authority.

### 4. Migration

A one-shot compactor (`glon-odin compact`):

1. read every `changes/<objectId>/*.pb`, write `<objectId>.glog`,
2. recompute each object's state from both layouts and **compare** — 861
   objects, must be byte-identical,
3. only then remove the old directories, keeping them until the parity check
   passes.

### 5. Expected result

| | before | after |
| --- | --- | --- |
| files | 12,480 | 861 |
| disk | ~49 MB | ~5 MB |
| payload | 4.8 MB | ~2–3 MB (superseded ops collapse) |
| boot replay | 12,480 decodes | 861 snapshots + short tails |
| new device | ~12.5k events over ~97 relay pages | 1 bundle + diffs |

### 6. Verification

- Engine fixtures: snapshot-then-ops replay equals full replay, for an object
  with chat blocks, a deleted object, and a snapshot racing a concurrent edit.
- Store test: a torn final frame truncates cleanly and loses only that frame.
- Prune test: a change not yet published is never dropped.
- Parity runner: computed state for all 861 objects identical before/after
  compaction (this is the migration gate).
- Bootstrap test: a fresh replica built from bundle + diffs equals one built by
  the full walk.
