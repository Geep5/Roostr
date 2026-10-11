# State sync: bases, live deltas, rebase, Blossom files

Status: specified; supersedes the "replay everything" contract of
`docs/checkpoint-sync.md` once every host ships it.

## Why

Every device used to download and replay every change ever made (73k+
events for one vault). Nostr has no standard for "the full history of a
document"; it has addressable events (relays keep only the newest per
address) and Blossom for blobs. Roostr now syncs **state**, not history:

- each object has one **base** - its state at an epoch - kept by relays as
  an addressable event, so only the newest survives;
- changes made since that base are **live deltas** (kind 1078, as before);
- a device holding a delta written against an older base **rebases** it:
  re-applies its ops on top of the current base as a new delta;
- a computer periodically **compacts**: folds the live deltas into a new
  base, then deletes the folded deltas from the relays (NIP-09);
- files are encrypted and stored on **Blossom** (BUD-01/02/11) served by
  RoostrRelay itself; objects reference them by hash.

Each computer keeps an append-only **local archive** of the changes it has
held (`<GLON_DATA>/archive/`), never published and never required for sync.

## Objects and epochs

A base is the existing `Checkpoint` protobuf with two meanings changed and
three fields added (`core/proto.odin`):

```proto
message Checkpoint {           // "Base" on the wire
  string object_id      = 1;
  repeated bytes head_ids    = 2;   // DAG heads folded into `state`
  repeated bytes covered_ids = 3;   // FOLDED: ids of the deltas this base folded since `prev_base`
                                    // (epoch 1: every change id the compactor held)
  ObjectSnapshot state  = 4;
  int64 created_at      = 5;        // unix ms; informational
  int64 epoch           = 6;        // 1, 2, 3 ... per object
  bytes prev_base       = 7;        // sha256 of the previous base's protobuf; empty at epoch 1
  bytes base_hash       = 8;        // NOT serialized: sha256 over fields 1-7 (computed)
}
```

`base_hash` = sha256 of the protobuf encoding of the base with field 8
absent. It is the base's identity.

**Current base** of an object: among the bases a device holds for it, the
one with the highest `epoch`; ties by highest `created_at`; then by
lexicographically highest `base_hash`. Deterministic on every device.

### Deltas

A delta is a kind-1078 change event exactly as today, plus one tag:

```
["b", <hex base_hash>]      // the base it was written on top of
```

Its `parent_ids` are either the base's `head_ids` or other live deltas of
the same base. A change without a `b` tag is **pre-migration**.

### What a device computes

`state(object) = current_base.state + replay(live deltas)` where **live
deltas** are the held changes that (a) carry `b` = current base hash, or
descend only from such deltas and the base heads, and (b) are not in
`covered_ids` of the current base. Replay order is the existing Kahn order
with hex tie-break (`core/dag.odin topo_sort`), seeded with the base's
heads as already applied. Replay never reaches back past the base.

An object with no base yet (new since the last compaction) replays its
deltas from its genesis change exactly as today.

### Orphans and rebase

A held delta is an **orphan** when it is not live and not covered:
its `b` names an older base and the current base's `covered_ids` does not
contain it (the compactor never saw it), or it is pre-migration and not in
an epoch-1 base's `covered_ids`.

Rebase (any device that holds an orphan; personal vault devices share the
key; in a shared space only a writer of that space):

1. new change: same `object_id`, same ops, same `author`, same
   `timestamp`; `parent_ids` = current base `head_ids` ∪ the live deltas
   that were heads when the orphan was found; `b` = current base hash.
2. Because changes are content-addressed and every field above is derived
   deterministically, two devices rebasing the same orphan produce the
   **same change id**; the second publish is a duplicate and dedupes.
3. The orphan itself is marked rebased locally (archived), never replayed.

Ops are intent-level (set field, add block after X, update block, move,
remove). Applying them on a newer state is well-defined: a `block_add`
whose target is gone appends (existing `place()`), an update/remove of a
missing block is a no-op. Concurrent edits are therefore applied one after
the other instead of merged character by character - accepted trade-off.

## Compaction

Who: the **computer that serves the object** (`harness/src/machine.ts
servesHere`). Shared-space objects: only the space owner's computer. The
web app and iOS never compact. A vault with no computer: objects keep
replaying their live deltas from the base (still bounded by the last
compaction) until a computer runs.

When: an object whose live deltas number >= 20, or total >= 48 KiB of
change bytes, or the oldest live delta is older than 24 h. Checked every
10 minutes and after startup reconcile (the existing checkpoint loop).

How:
1. Compute state = current base + live deltas (as above).
2. New base: epoch+1, `prev_base` = current base hash (empty if none),
   `covered_ids` = the live deltas folded, `head_ids` = their heads.
3. Publish the base (below). Once every configured relay accepted every
   part, delete the folded deltas' events (NIP-09 kind 5, `e` tags, `k`
   1078, <= 254 per event) and the previous base (`a` tag
   `31078:<pubkey>:<d>` covers all older versions at that address; parts
   of a chunked base are deleted by `e`).
4. Epoch 1 (migration): `covered_ids` = every change the computer holds for
   the object; after **every device has upgraded** the computer deletes
   all pre-migration 1078/1079 events from the relays.

Concurrent compaction (two computers, rare): both bases exist briefly;
every device picks the same current base (rule above); deltas the losing
base folded that the winner did not are orphans relative to the winner
and get rebased. Nothing is lost.

## Wire format

All content is NIP-44 v2 with the existing keys (personal conversation key;
shared space key) and existing blinded `h` tags (`core/wire.odin`).

| Event | Kind | Tags | Content |
|---|---|---|---|
| Base | **31078** (addressable) | `["d", blind(prefix,"base:"+objectId)]`, `["h", <object stream tag>]`, space tag + `owner` as 1078, `["epoch", n]`, chunk `["c", gid, i, n]` when split | NIP-44(base64(Checkpoint.pb)) |
| Base part (2..n) | **1080** (regular) | `["h", ...]`, `["c", gid, i, n]` | one part |
| Delta | 1078 | as today + `["b", base_hash]` | as today |
| Deletion | 5 | `e` (deltas, base parts), `a` (old base), `k` | - |
| Blob auth | 24242 | BUD-11 | - |

A base that fits one part (the common case) is a single 31078 event. A
larger base: part 1 rides in the 31078 event, parts 2..n are kind-1080
events published **before** the 31078 event; the 31078's `c` tag carries
the group id, so a device fetching the 31078 queries `kinds:[1080],
#c:[gid]` (relays index single-letter tags) to reassemble.

Part size: base64 parts of at most `WIRE_CHUNK_CHARS` = 40,000 characters
(unchanged) so a sealed part stays under strfry's default `maxEventSize`
(65,536 bytes) and under 65,535 bytes of NIP-44 plaintext for libraries
without the extended length prefix. Large payloads (files, images, video)
never ride in events: they go to Blossom.

Kind 1079 checkpoints are retired; readers keep importing them until the
pre-migration sweep removes them.

## Sync on a device

1. **Bases first.** NIP-77 reconcile `{kinds:[31078], authors:[me]}` plus
   each space stream (`#h`), fetch missing bases and their 1080 parts.
   Every object renders from its base as soon as it lands.
2. **Live deltas.** For objects whose base is held: reconcile
   `{kinds:[1078], #b:[...current base hashes]}` in batches, plus deltas of
   objects with no base (`#h` object tags, or `since` the newest base's
   `created_at` minus 1 day as a bounded fallback when a relay lacks NIP-77).
3. **Live subscription** as today (`since = cursor+1`) on 1078, 31078,
   1080, 5.
4. Never walks history from event zero again.

Hosts: daemon + harness (`glonOdin`), web (`RoostrWebsite/src/lib/engine`),
iOS (`RoostrIOS/Sources/RoostrSync`). The core (`core/`, shared via WASM
and the xcframework) owns: base encode/decode/hash, current-base choice,
live/orphan classification, rebase change construction, replay from base,
sealing/opening bases.

## Files on Blossom (RoostrRelay)

RoostrRelay serves Blossom on its existing port:

- `GET|HEAD /<sha256>[.ext]` - the blob (Range supported); public by hash,
  bytes are ciphertext.
- `PUT /upload` - body = blob; `Authorization: Nostr <base64 kind-24242>`
  (BUD-11: `t`=upload, `x`=sha256, `expiration`); only pubkeys allowed to
  write to the relay (static or dynamic allowlist). Returns the BUD-02 blob
  descriptor. Max blob 512 MiB.
- `DELETE /<sha256>` - same auth, `t`=delete; only the uploader.
- `GET /list/<pubkey>` - BUD-02 list, uploader only.
- Storage: `<DB dir>/blobs/<sha256>`; written to a temp file, hashed while
  streaming, renamed on success.

Client side: a file is encrypted with a fresh random 32-byte key using
AES-256-GCM in 4 MiB frames (frame nonce = 12-byte big-endian frame index;
each frame carries its 16-byte tag), uploaded,
and the File object records `blob_sha256` (of ciphertext), `blob_key`
(hex), `blob_size`, `mime`, `name`. The object itself is encrypted on the
relays, so the key never travels in clear. The harness peer-to-peer store
stays as a local cache; the iOS app and the browser fetch from Blossom, so
files work everywhere.

The server list is the user's BUD-03 kind-10063 event, defaulting to the
RoostrRelay origin (`https://roostr-relay.fly.dev`).

## Rollout

1. Core + tests; relay (31078/1080 acceptance, `#b`/`#c` indexing, Blossom).
2. Hosts read bases and live deltas and rebase orphans, while still
   accepting pre-migration history (dual read).
3. Computers start compacting (epoch 1 bases for every object).
4. Every device upgraded (web is live on deploy; iOS via TestFlight;
   every computer pulled and restarted) -> computers sweep pre-migration
   1078/1079 events from Roostr's relay.
5. Then imports (Anytype) publish epoch-1 bases directly.
