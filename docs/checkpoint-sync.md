# Checkpoints: one cached state per object, the DAG stays the truth

Status: core, daemon, harness and browser implemented.

## The complaint

A fresh device (new laptop, wiped browser) had to replay every object from
genesis before it could show anything, and boot on a full-history machine
re-replayed every `.pb` as well. The DAG is canonical and stays canonical -
but nothing should have to *walk* it to render a page.

## The contract

A **checkpoint is a replay cache**. It lets a replica render an object before
(or without) replaying its history. It is never authority to skip, drop or
delete history:

- Every replica still reconciles the full kind-1078 history from event zero
  on every startup. Devices are not assumed to hold identical state; the
  relay is transport, not a source of truth, and a checkpoint is one
  device's opinion of one branch at one moment.
- Originals folded into a checkpoint are still stored and still published.
  Nothing is skipped because "the checkpoint covers it".
- Superseded or unrelated checkpoints on the relay are left alone. No NIP-09
  for kind 1079: the one another device published may be the only copy of
  its branch.
- There is no manifest, floor, or "history up to time C is covered" claim.
  Kind 30079 is obsolete; readers ignore it.

## What a checkpoint is

A computed state plus the exact set of changes it folds in:

```proto
message Checkpoint {
  string object_id            = 1;
  repeated bytes head_ids     = 2;  // DAG heads at checkpoint time
  repeated bytes covered_ids  = 3;  // every change id replayed into `state`, in replay order
  ObjectSnapshot state        = 4;  // fields + blocks + flags
  int64 created_at            = 5;  // unix ms; informational only
}
```

It is **not a Change** and never enters the DAG. `Change.snapshot` (field 7)
stays in the codec for compatibility; nothing produces it.

`covered_ids` is what makes replay deterministic with a partial history: a
device holding only a checkpoint cannot otherwise tell an ancestor (already
folded in) from a concurrent change (must be replayed). It also carries the
publisher's Kahn order, so a tail can continue the run where the publisher
stopped. 32 bytes per covered change.

### Replay with a checkpoint (`core/dag.odin`)

`compute_state(changes, checkpoint)` goes through `checkpoint_for_replay`:

- every covered id present and the checkpoint is a prefix of the full Kahn
  order → seed from it (same answer, shorter replay);
- every covered id present but the order diverged (a concurrent change with a
  smaller id arrived later) → ignore it, replay from genesis;
- covered ids missing, but the held changes form a closed history the
  checkpoint neither prefixes nor continues → ignore it: what this replica
  holds is real history, the checkpoint is another branch (or a forgery);
- covered ids missing otherwise → the checkpoint stands in for them. The tail
  is replayed on top only when `checkpoint_tail_continues` can prove the
  order a full replay would use (each tail root's last covered parent is a
  checkpoint head); otherwise the checkpoint state stands alone rather than
  showing a merge no full replay would produce.

`heads` = tail heads ∪ `head_ids` no tail change built on. A full-history
replica and a checkpoint-only replica reach the same state and heads from the
same checkpoint; `core/replay_test.odin` pins it, including incomparable forks
and the late-concurrent-change case.

### Store rule: containment, never count or time

`checkpoint_supersedes(candidate, existing)`: same `object_id`, and the
candidate's covered set is a superset of the existing one. Strict superset
wins; equal set → larger sha256 of the bytes wins. An incomparable pair (two
devices checkpointed different branches) never displaces either: the holder
keeps what it has, and the next checkpoint built from merged history covers
both. Nothing consults `created_at`. Every host asks the core: the daemon
directly, the browser through codec action `checkpoint_supersedes`.

### Building: full history only

`checkpoint_build` replays from genesis; there is no "seed from the prior
checkpoint" path. The daemon's `POST /api/checkpoints/build` refuses with
`409 history incomplete` when the object has no changes, a parent is missing
(`dag_closed`), or a stored checkpoint covers ids the daemon does not hold.
A replica that does not hold the whole history never mints a checkpoint; the
harness logs and tries again next pass.

### Trust

A checkpoint bypasses per-op authority, so its author is the only thing a
receiver can check:

- personal objects: accepted only from the identity's own pubkey;
- shared spaces: accepted only when the Nostr signer **is the space owner**
  from the installed keyring. Members' checkpoints are ignored.

Only the serving harness of the owner publishes checkpoints.

## Wire (Nostr)

| kind | shape | purpose |
| --- | --- | --- |
| `1078` | regular, one Change | unchanged; the history every replica holds in full |
| `1079` | regular, one Checkpoint | cached state per object |

**1079** reuses the 1078 envelope byte for byte: NIP-44 self- or space-key
encryption of the base64 Checkpoint bytes, the same blinded `h` tags, the same
`c` chunk tags over 40k characters. Regular, not addressable: chunked parts
share a `d` and addressable replacement would erase all but the last part.

`core/sync_session.odin` `sync_ingest` accepts both kinds through one
reassembly path; the item carries `change` for 1078 and
`checkpoint: {objectId, headIds, hash}` for 1079.

### Any start

Every replica, every startup, regardless of what it held before:

1. Walk `kinds:[1078, 1079]` for `authors:[me]` and per space tag from event
   zero (`since` never shortened by checkpoints). Pages import checkpoints
   before changes so an object renders from its cache while its originals
   stream in behind it.
2. Live subscriptions carry both kinds from `cursor + 1`.
3. At EOSE on every relay without faults, `sync {action:"retire"}` drops open
   **1079** chunk groups (a chunk dropped, or a publish that never finished):
   a checkpoint is only a cache. Change groups are never retired: a missing
   change is missing data and keeps the replay floor until a covering repair.

Under its own key the harness treats a received 1079 as *the relay's copy* of
that object only when the daemon reports `held` (it stored these exact bytes,
or already had them). Anything else - a subset, an incomparable fork from
another device - is remembered nowhere and deleted never.

### Publishing (harness, `nostrsync.ts`)

Every `CHECKPOINT_INTERVAL_MS` and after the startup reconcile:

1. `GET /api/checkpoints` → per object: current heads, checkpoint heads/hash.
2. For every object whose heads moved (or has no checkpoint), and which is
   personal or in a space this identity owns: `POST /api/checkpoints/build`.
   `409 history incomplete` → skip, retry next pass.
3. Seal and publish as 1079; remember the event ids as the relay's copy. The
   previous event stays on the relay.

A checkpoint that will not fit in 64 chunks is skipped and logged; the object
keeps syncing as changes.

## Daemon (`src/`)

- `GLON_DATA/checkpoints/<objectId>.pb` - one file per object, temp/fsync/
  rename like changes. Verified by decoding and by `object_id` matching.
- `load_object` reads the checkpoint (if any) and the object directory (if
  any) and calls `compute_state(changes, checkpoint)`.
- `POST /api/changes` stores every change, covered or not.
- `GET /api/checkpoints` → `{objectId: {heads, checkpointHeads|null, checkpointHash, changes, covered}}`
- `POST /api/checkpoints/build` `{objectId}` → `{objectId, b64, hash, heads, covered}` or `409 history incomplete`
- `POST /api/checkpoints` `{checkpoints:[b64], provenance?}` → import with the
  trust and containment rules; each row reports `stored` and `held`.

## Browser (`RoostrWebsite/src/lib/engine`)

- IndexedDB (`DB_VERSION` 3) `checkpoints` store keyed by object id
  (`CheckpointRow {objectId, bytes, hash, heads}`). `putCheckpoint` asks the
  core (`checkpointSupersedes` in `proto.ts`) and returns whether the row
  changed; `objectIds()` and the boot scan union change and checkpoint keys,
  so an object held only as a checkpoint is queryable.
- `RelaySync.walkHistory`: one `kinds:[1078, 1079]` filter per scope from
  `since`; a full walk is from event zero. At EOSE it drains live events and
  imports in flight, calls the core's `retire`, then judges completion.
- `start()` calls `forgetCheckpointFloors()`: a device that an earlier build
  walked from a manifest floor never held the older history, so the record
  and its `bootstrapped` flag are dropped and it walks from zero once.
- `setSharedSpaces` queues a fresh space's full walk synchronously; a second
  call in the same tick cannot cancel it.
- Trust: personal 1079 must be signed by this key (core session rule); shared
  1079 goes through `authorizeSharedCheckpoint` (owner only, scoped to the
  space). The browser never publishes checkpoints.
- Corpus frames: `[u32 LE length][bytes]`; bit 31 set frames a Checkpoint.
- `replay` and mutation `heads` accept `checkpoint: <base64>`.
- State memo keys include the checkpoint hash.
- `scripts/sync-checkpoint.test.ts` and `scripts/sync-authority.test.ts` pin
  import, containment supersede, owner-only shared trust, checkpoint-only cold
  boot, the legacy-floor migration and the repeated-space-refresh case.

## Not a follow-up: dropping covered `.pb` files

Dropping originals a checkpoint covers would turn the cache into the only
copy of history and make a replica unable to heal a relay that lost them. It
is out of scope under this contract.
