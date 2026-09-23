# Checkpoints: one state per object, small deltas, ask for what is new

Status: core, daemon, harness and browser implemented. Disk consolidation
(one file per object) is the follow-up this format enables.

## The complaint

A fresh device (new laptop, wiped browser) had to pull every change ever made
and replay each object from genesis before it could show anything. Boot on a
full-history machine re-read and re-replayed every `.pb` as well. The DAG is
canonical and stays canonical - but nothing should have to *walk* it to
render a page.

## What a checkpoint is

A **checkpoint** is a computed state plus the exact set of changes it folds in:

```proto
message Checkpoint {
  string object_id            = 1;
  repeated bytes head_ids     = 2;  // DAG heads at checkpoint time
  repeated bytes covered_ids  = 3;  // every change id replayed into `state`
  ObjectSnapshot state        = 4;  // fields + blocks + flags
  int64 created_at            = 5;  // unix ms; informational only
}
```

It is **not a Change** and never enters the DAG. The earlier idea - a
`Change.snapshot` in the object's own history - was rejected: every peer would
have to store a full copy of the state on each compaction pass forever, and a
snapshot too large for the relay would leave a hole in the history that
children of that change reference. `Change.snapshot` (field 7) stays in the
codec for compatibility; nothing produces it.

`covered_ids` is what makes replay deterministic with a partial history. A
device holding only a checkpoint cannot tell an ancestor of the checkpoint
(already folded in, must be skipped) from a concurrent change (must be
replayed) - both look like changes whose parents are missing. The explicit
list answers it without guessing. It costs 32 bytes per covered change: 3 KB
for a hundred-change page, ~400 KB for a 12k-change chat, sent only when that
object is re-checkpointed.

### Replay with a checkpoint (`core/dag.odin`)

`compute_state(changes, checkpoint)`:

1. Seed `type_key`, `fields`, `blocks`, `deleted`, `created_at`,
   `updated_at` from `checkpoint.state`.
2. Drop every change whose id is in `covered_ids`. What remains is the tail.
3. Toposort and replay the tail exactly as before. Parents that are covered
   are satisfied; Kahn already ignores parents it cannot see.
4. `heads` = tail heads ∪ `head_ids` not referenced by any tail change.

A full-history machine and a checkpoint-only machine compute the same state and
the same heads from the same checkpoint. `core/replay_test.odin` pins it: for
every fixture, `compute_state(all)` == `compute_state(tail, checkpoint(prefix))`.

**Selection by ancestry, never by timestamp.** When a store holds two
checkpoints for one object it keeps the one with more `covered_ids`, tie-broken
by the sha256 of the bytes. Nothing consults `created_at`.

**Gating lives in the core.** Hosts hand `compute_state` whatever checkpoint
they hold; `checkpoint_for_replay` decides whether it applies: covered ids
missing locally → the checkpoint stands in for them; every covered id present
and forming a prefix of the DAG → the checkpoint is a shortcut; anything else
(a checkpoint that does not fit the held changes) → ignored, the DAG wins. The
daemon's `load_object_dir`, the browser's replay/`heads`/corpus paths and the
harness all go through this one rule; no host does its own prefix check.

### Trust

A checkpoint bypasses per-op authority, so its author is the only thing a
receiver can check:

- personal objects: accepted only from the identity's own pubkey (self-decrypt
  already guarantees this);
- shared spaces: accepted only when the Nostr signer **is the space owner**
  from the installed keyring. Members' checkpoints are ignored.

Only the serving harness of the owner publishes checkpoints.

## Wire (Nostr)

| kind | shape | purpose |
| --- | --- | --- |
| `1078` | regular, one Change | unchanged |
| `1079` | regular, one Checkpoint | latest state per object |
| `30079` | addressable, `d=roostr-checkpoint` | "everything up to relay time C is covered" |

**1079** reuses the 1078 envelope byte for byte: NIP-44 self- or space-key
encryption of the base64 Checkpoint bytes, the same blinded `h` tags, the same
`c` chunk tags for anything over 40k characters. It is a *regular* kind, not
addressable, because chunked parts share a `d` and addressable replacement
would erase all but the last part. Superseded checkpoints are removed with the
existing NIP-09 path (`k=1079`), and a receiver that sees several picks the
largest covered set anyway.

`core/sync_session.odin` `sync_ingest` accepts both kinds through one
reassembly path; the item it returns carries `change` for 1078 and
`checkpoint: {objectId, headIds, covered, hash}` for 1079.

**30079** is the manifest the publisher writes after a *complete* checkpoint
pass: NIP-44 JSON `{"cursor": <relay seconds>, "objects": n}`. The personal
manifest is self-encrypted under `d=roostr-checkpoint`; a space owner also
writes one per owned space under `d=roostr-checkpoint/<spaceTag>`, sealed
with the space key and `h`-tagged, so members can read it. Its meaning:
"every object whose heads had moved by relay time `cursor` has a checkpoint
that folds those changes in." An object left unchanged for months keeps its
old checkpoint; nothing arrived for it in between, so `since = cursor` misses
nothing for it either.

### Cold start

A device with no local history and no cursor:

1. `REQ {kinds:[30079], authors:[me], #d:[roostr-checkpoint]}` and, per shared
   space owned by someone else, `{authors:[owner], #d:[roostr-checkpoint/<spaceTag>]}`.
   No manifest → that scope falls back to the full walk (today's behaviour).
2. `REQ {kinds:[1079], authors:[me]}` and `{kinds:[1079], #h:[spaceTags]}` -
   never bounded by `since`: one per object, and a stale copy is what the next
   pass replaces. Reassemble, import (trust rule above), persist.
3. Walk `1078` with `since = manifest.cursor` (per space: the owner's manifest
   cursor). Cursor semantics are unchanged from the live subscription: the
   publisher itself relies on exactly the same "seen up to C" guarantee.
4. Live subscriptions carry `kinds:[1078, 1079]`; a live checkpoint is imported
   like a cold one, which also lets full-history machines shorten their replay.
   Backfills process checkpoints before changes so the daemon skips what they
   cover instead of storing it.
5. A publisher supersedes a checkpoint by publishing the new one, stamping the
   manifest, then NIP-09'ing the old event(s). A receiver that caught one chunk
   of the old checkpoint before the delete would otherwise hold that group open
   forever. The core session keys chunk groups by kind
   (`[pubkey, spaceId, keyId, gid, kind]`) and `sync {action:"retire", since}`
   drops open **1079** groups and their replay obligations once a walk from
   `since` finished on every relay without faults. Change groups are never
   retired: a missing change is missing data and keeps the floor until a
   covering repair.

The harness records `checkpointFloor` (and `checkpointFloors` per foreign
space tag) in `sync-state.json` and scans from them on later boots; a machine
that bootstrapped from checkpoints has no covered changes to re-publish, so
the "no since, heal the relay" scan does not apply to it.

Under its own key the harness also treats a received 1079 as *the relay's
copy* of that object: the daemon's import result says whether it superseded
the stored one. Accepted → remembered as current (so the pass does not
republish); already covered by a better local one → a NIP-09 `k=1079` for it.
Two machines under one key converge to the daemon's supersede rule this way.

### Publishing (harness, `nostrsync.ts`)

Every `CHECKPOINT_INTERVAL_MS` and after the startup reconcile:

1. `GET /api/checkpoints` → per object: current heads, checkpoint heads.
2. For every object whose heads differ (or has no checkpoint), and which is
   personal or in a space this identity owns: `POST /api/checkpoints/build
   {objectId}` → checkpoint bytes, persisted by the daemon.
3. Seal and publish as 1079; on success NIP-09 the previous event ids for that
   object and remember the new ones.
4. When the whole pass succeeded: publish 30079 with the harness cursor.

A checkpoint that will not fit in 64 chunks is skipped and logged; the object
keeps syncing as changes.

## Daemon (`src/`)

- `GLON_DATA/checkpoints/<objectId>.pb` - one file per object, written with
  the same temp/fsync/rename discipline as changes. Not content-addressed by
  name; the bytes are verified by decoding and by `object_id` matching the
  file.
- `load_object` reads the checkpoint (if any) and the object directory (if
  any) and calls `compute_state(changes, checkpoint)`. Objects known only by
  checkpoint load with an empty tail.
- `POST /api/changes` skips a change whose id is covered by the stored
  checkpoint (reported in `ids` so the harness marks it published).
- `GET /api/checkpoints` → `{objectId: {heads, checkpointHeads|null, changes}}`
- `POST /api/checkpoints/build` `{objectId}` → `{objectId, b64, heads, covered}`
- `POST /api/checkpoints` `{checkpoints:[b64], provenance?}` → import with the
  trust rule; keeps the larger covered set.

`/api/sync/digest` and `/api/changes` describe the *tail* on a checkpoint-only
machine; fingerprints differ from a full-history machine by design.

## Browser (`RoostrWebsite/src/lib/engine`)

- IndexedDB (`DB_VERSION` 3) gains a `checkpoints` store keyed by object id
  (`CheckpointRow {objectId, bytes, hash, heads, covered}`) and META
  `checkpoint-floors`: `{"": personalCursor, "<spaceTag>": ownerCursor}`.
  `putCheckpoint` applies the covered-then-hash rule and returns whether the
  row changed; `objectIds()` and the boot scan union change and checkpoint
  keys, so an object held only as a checkpoint is queryable.
- `RelaySync.walkHistory`: a full walk (`since <= 1`) fetches each scope's
  manifest once, persists the cursor as that scope's floor, and issues two
  filters per scope: `1078 since: max(since, floor)` and `1079 since`
  (unbounded on a full walk). Pages import checkpoints before changes. After
  a clean complete walk it calls the core's `retire` (rule above). Live
  subscriptions and head checks use `kinds:[1078, 1079]`.
- Trust: personal 1079 must be signed by this key (core session rule); shared
  1079 goes through `authorizeSharedCheckpoint` (owner only, scoped to the
  space). The browser never publishes checkpoints or manifests.
- Corpus frames: `[u32 LE length][bytes]` as before; a length with bit 31 set
  frames a Checkpoint instead of a Change. The core groups both by object.
- `replay` and mutation `heads` accept `checkpoint: <base64>`.
- State memo keys include the checkpoint hash: replacing 500 changes with one
  checkpoint must not read as "count unchanged".
- `scripts/sync-checkpoint.test.ts` pins import, supersede, owner-only shared
  trust and checkpoint-only cold boot.

## Follow-up this enables: one file per object

With covered ids explicit, a full-history machine can drop `.pb` files that a
locally built checkpoint covers and keep `checkpoints/<id>.pb` + the tail.
That is the log-plus-snapshot layout `durable-state.md` deferred. Not done
here: a machine that drops covered changes can no longer heal a relay that
lost them, so the publisher should keep full history until relay retention is
understood.
