# State sync: bases, live deltas, rebase, Blossom files

Status: core, daemon and harness implemented (compaction and deletions
behind flags, see "Computers"); web and iOS replicas implemented in Rust
(`RoostrWebsite/gpui/crates/roostr-replica`). Supersedes the
"replay everything" contract of `docs/checkpoint-sync.md`.

## Why

Every device used to download and replay every change ever made (73k+
events for one vault). Nostr has no standard for "the full history of a
document"; it has addressable events (relays keep only the newest per
address) and Blossom for blobs. Roostr now syncs **state**, not history:

- each object has one **base** - its state at an epoch - kept by relays as
  an addressable event, so only the newest survives;
- changes made since that base are **live deltas** (kind 1078, as before);
- the device that wrote a delta against an older base **rebases** it when
  the newer base missed it: re-applies its ops on top of the current base as
  a new delta; every other device discards it;
- a computer periodically **compacts**: folds the live deltas into a new
  base, then deletes the folded deltas from the relays (NIP-09);
- files are encrypted and stored on **Blossom** (BUD-01/02/11) served by
  RoostrRelay itself; objects reference them by hash.

Each computer keeps a local **folded-id index** of the changes that left its
working set (`<GLON_DATA>/folded/`): ids only, never published and never
required for sync; it keeps imports from bringing a folded change back.

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

**Own changes until a base proves them; everyone else's leftovers are
discarded.** "Own" means written on *this device* - a device-local marker
(daemon `.local`, replica `own:` mark), never the author pubkey: personal
vault devices share one key and author, and a shared space's writers are
many.

- A device keeps every change it wrote - published or not - until it holds
  a base whose covered chain proves it folded (below). Publishing is not
  folding: a published change the compactor missed is exactly what used to
  become an orphan nobody answered for.
- When a newer base does not cover an own change and it is not live, the
  device **rebases** it (in a shared space only while it may write there)
  and publishes the copy; the copy is own, the original is folded away.
- Everyone else's held changes that are not live under the current base -
  orphan or stale, another device's or another author's - are **discarded**
  (folded away), never rebased by this device: their writer does that.
- Once an own change is proven folded, its marker goes and it is folded
  away.

Rebase:

1. new change: same `object_id`, same ops, same `author`, same
   `timestamp`; `parent_ids` = current base `head_ids` ∪ the live deltas
   that were heads when the orphan was found; `b` = current base hash.
2. Because changes are content-addressed and every field above is derived
   deterministically, rebasing the same orphan again with the same holdings
   produces the **same change id**; a repeated publish dedupes.
3. The orphan itself is marked rebased locally (folded index), never replayed.

Mixed versions: a device older than this rule still rebases every orphan it
holds. Harmless: its copy carries the same edit key, so the writer's own
orphan is Covered by it (never rebased twice), and copies dedupe (Decisions).

Ops are intent-level (set field, add block after X, update block, move,
remove). Applying them on a newer state is well-defined: a `block_add`
whose target is gone appends (existing `place()`), an update/remove of a
missing block is a no-op. Concurrent edits are therefore applied one after
the other instead of merged character by character - accepted trade-off.

### Decisions (core)

Where the text above left room, `core/state_sync.odin` reads it
conservatively:

- **`base_hash`** is sha256 of the base bytes *as received* with any field 8
  removed - never a re-encoding - so a field a newer writer adds still counts.
- **Covered** means in `covered_ids` of the current base *or of any held
  ancestor reached through `prev_base`*. `covered_ids` only lists one
  compaction's fold, so checking the current base alone would call a delta
  folded two compactions ago an orphan and re-apply its (older) ops.
- **Live by descent** applies whatever the `b` tag says (or its absence): a
  change whose parents are all base heads or live deltas was written on
  this state, so it is replayed as is. This keeps pre-upgrade clients
  (no `b` tag) working on top of a base, and a delta written on a losing
  concurrent base that only built on what the winner also holds needs no
  rebase. A change with no parents is never live by descent.
- **Stale** (fifth class): not live, not covered, and the device cannot
  prove no base folded it, because a base newer than the one it was written
  on is missing from the held chain (bases are replaced at their address,
  so a device offline across two compactions never sees the middle one).
  Stale changes are neither replayed nor rebased. Decidable (→ orphan) when:
  written on chain epoch `e` and every chain base from `e+1` is held; on a
  held sibling base of epoch `e` and every chain base from `e` is held;
  pre-migration or on an unknown base and the chain is held back to epoch 1;
  or the host lists it as `pending` (never published - no compactor can have
  seen it). Rebasing a folded change would silently revert later edits. An
  own stale change (published, then this device missed a compaction) stays
  held with its marker - never replayed, rebased or discarded; another
  device's is discarded.
- **Own** = the host's `own` ids plus its `pending` ids (never published
  implies written here).
- **Proven folded** = the own change's id is in `covered_ids` of a held
  *strict ancestor* of the current base, or it is an orphan whose edit key
  matches a change such an ancestor folded (an older device's copy of it).
  Folded by the current base alone is not proof: a concurrent sibling base
  that wins later may not have folded it, and only its writer would rebase
  it. So the marker outlives one more compaction.
- **Discard** = not own, and Orphan, Stale, or an orphan Covered only by
  edit key (another device's copy of an applied edit) - except a change
  **waiting** for a base or parent still on its way: written at or after the
  current base's `created_at`, and tagged with a base neither held nor named
  by the held chain, or naming a parent neither held, a base head nor
  covered (a pointer base whose blob has not loaded, events out of order).
  Waiting changes stay held, unreplayed; once a later base exists they are
  leftovers like any other. Folding away a waiting change would refuse it
  for good when its base lands.
- **Pre-migration covered**: an untagged change in the epoch-1 base's
  `covered_ids` (what the pre-migration sweep may delete).
- **Rebase of several orphans**: all own orphans of an object are rebased in
  one call against the same live heads, in Kahn order; an orphan whose parent
  is also being rebased additionally names that parent's *rebased* id, so a
  chain of orphans stays a chain. Parents are sorted bytewise (= hex order).
  The rebased change carries no legacy in-DAG snapshot. `orphans` naming
  another device's orphan rebases nothing for it.
- **One edit, many copies**: the "same change id" promise above only holds
  for devices that saw the same live heads. Copies made with different heads
  differ in id, and a copy that lands after the compactor folded another
  one is an orphan again - rebasing it made yet another copy, which the
  next compaction orphaned in turn (26k copies of one block_add on a busy
  agent object). So an edit is identified across copies by its **edit key**
  - sha256 of the change with only object, author, timestamp and ops - and:
  an orphan whose edit key matches a live or covered change is **Covered**
  (already applied; never rebased, never replayed), and copies of one edit
  among the orphans rebase once (the others map onto that copy for their
  children's parents). With rebasing limited to own changes, new copies only
  come from retries and from older devices; a replica that strips covered
  changes from its requests keeps the covered ones sharing author and
  timestamp with a held own change, so this check still sees them.

## Compaction

Who: the **computer that serves the object** (`harness/src/machine.ts
servesHere`). Shared-space objects: only the space owner's computer. The
web app and iOS never compact. A vault with no computer: objects keep
replaying their live deltas from the base (still bounded by the last
compaction) until a computer runs.

Unbased fallback: in every compaction pass a computer also compacts
(epoch 1) **every object with no base whose oldest change is older than
12 h**, whoever serves it, in every stream it may compact (personal;
a shared space only when this identity owns it). Served objects with a
base keep the rules below. Why: a fresh device walks each stream only from
its newest base minus a day (Sync on a device), so an object nobody bases -
its serving computer offline for more than a day, or not upgraded yet
during rollout - would otherwise drop out of every fresh replica once its
events age past that window. Two computers building the epoch-1 base
concurrently resolve by the current-base rule.

When: an object whose live deltas number >= 20, or total >= 48 KiB of
change bytes, or the oldest live delta is older than 24 h. Checked every
10 minutes and after startup reconcile (the existing checkpoint loop).

How:
1. Compute state = current base + live deltas (as above).
2. New base: epoch+1, `prev_base` = current base hash (empty if none),
   `covered_ids` = the live deltas folded, `head_ids` = their heads.
3. Publish the base (below; an oversized one goes to Blossom first, see
   "Oversized bases"). Once every configured relay accepted every
   part, delete the folded deltas' events (NIP-09 kind 5, `e` tags, `k`
   1078, <= 254 per event) and the previous base (`a` tag
   `31078:<pubkey>:<d>` covers all older versions at that address; parts
   of a chunked base are deleted by `e`; a pointer base's blob by BUD-02
   DELETE once that deletion reached every relay).
4. Epoch 1 (migration): `covered_ids` = every change the computer holds for
   the object; after **every device has upgraded** the computer deletes
   all pre-migration 1078/1079 events from the relays.

Concurrent compaction (two computers, rare): both bases exist briefly;
every device picks the same current base (rule above); deltas the losing
base folded that the winner did not are orphans relative to the winner
and their writers rebase them - which is why a marker survives a fold by
the current base alone. Nothing is lost while the writer runs.

Decisions (core): the thresholds (`COMPACT_MIN_DELTAS` 20,
`COMPACT_MIN_BYTES` 48 KiB of encoded change protobuf, `COMPACT_MAX_AGE_MS`
24 h) apply to epoch 1 too - pre-migration objects are old, so the age rule
makes them due at once, while objects created after the last base wait like
any other; `force` compacts anything with a live delta (imports, manual
migration). Epoch 1 over a legacy 1079 checkpoint folds the checkpoint's
`covered_ids` plus exactly the tail the replay applied. Orphans and stale
changes are never folded (the plan reports their counts: their writers
rebase them, every other device discards them).
`created_at` = the host's `nowMs`. A delta only the losing base folded that
builds solely on the winner's heads is live by descent rather than an
orphan: same state, no new id.

## Wire format

All content is NIP-44 v2 with the existing keys (personal conversation key;
shared space key) and existing blinded `h` tags (`core/wire.odin`).

| Event | Kind | Tags | Content |
|---|---|---|---|
| Base | **31078** (addressable) | `["d", blind(prefix,"base:"+objectId)]`, `["h", <object stream tag>]`, space tag + `owner` as 1078, `["epoch", n]`, chunk `["c", gid, i, n]` when split, `["blob", sha256, size]` when a pointer | NIP-44(base64(Checkpoint.pb)), or NIP-44(pointer JSON) |
| Base part (2..n) | **1080** (regular) | `["h", ...]`, `["c", gid, i, n]` | one part |
| Delta | 1078 | as today + `["b", base_hash]` | as today |
| Deletion | 5 | `e` (deltas, base parts), `a` (old base), `k` | - |
| Blob auth | 24242 | BUD-11 (`t` upload / delete, `x` sha256) | - |

A base that fits one part (the common case) is a single 31078 event. A
larger base: part 1 rides in the 31078 event, parts 2..n are kind-1080
events published **before** the 31078 event; the 31078's `c` tag carries
the group id, so a device fetching the 31078 queries `kinds:[1080],
#c:[gid]` (relays index single-letter tags) to reassemble.

Part size: base64 parts of at most `WIRE_CHUNK_CHARS` = 40,000 characters
(unchanged) so a sealed part stays under strfry's default `maxEventSize`
(65,536 bytes) and under 65,535 bytes of NIP-44 plaintext for libraries
without the extended length prefix. Large payloads (files, images, video,
oversized bases) never ride in events: they go to Blossom.

Kind 1079 checkpoints are retired; readers keep importing them until the
pre-migration sweep removes them.

Decisions (core): the 31078 event carries part 0 (`["c", gid, "0", n]`) and
the 1080 events parts 1..n-1; every part carries the same `h` tags and
`owner` as the base (deletion consent, as on 1078). Ingest keys the 31078
and its 1080 parts as one chunk group of kind 31078, and such groups retire
like checkpoint groups (a superseded base's parts may be gone for good). A
1080 without a `c` tag, or a 31078 whose content is not a base of epoch >= 1,
is not an item. Ingest does not check the `d` tag: authenticity comes from
the key the content opened under plus the signer rule (`authorizeBase` for
space objects). `b` is taken from a 1078 only as 64-char lowercase hex.

### Oversized bases

A base whose base64 needs more than `WIRE_MAX_CHUNKS` (64) parts - over
2.56 MB, e.g. a long-running agent's transcript - is stored as one
**Blossom blob** and its 31078 carries a pointer instead of parts:

- Blob: the raw Checkpoint protobuf (not base64) encrypted in the Blossom
  file format (AES-256-GCM over 4 MiB frames, frame i's nonce = i;
  `harness/src/blossom.ts`, `roostr_core::blossom`) under
  `key = HMAC-SHA256(<the base's NIP-44 key>, "roostr-base-blob-v1" ||
  base_hash)` - the personal conversation key or the space key, exactly
  what seals the event's content. Deterministic, so a retried seal uploads
  the same blob; one key per base, so frame nonces never repeat under a key.
  Uploaded with BUD-02 `PUT /upload` (BUD-11 `t=upload`), named by the
  sha256 of the ciphertext.
- 31078: the usual tags (`d`, `h`…, `owner`, `epoch`), no `c`, plus
  `["blob", <sha256 hex>, <size>]`; no 1080 parts. Content = NIP-44 of
  `{"v":1,"hash":<base_hash hex>,"sha256":<blob sha256>,"size":<bytes>,"key":<hex>,"url"?:<upload URL>}`.
  The key travels only inside the encrypted content, as a File object's
  `blob_key` does.
- Sealing (core `seal_base`): without `blob`, an oversized base returns
  `{hash, objectId, epoch, d, gid: "", needsBlob: true, blobKey}` and no
  event; the host encrypts, uploads and seals again with
  `blob: {sha256, size, url}`, which returns the pointer event plus
  `blob: {sha256, size, key}`. Bases that fit are sealed inline as before.
- Reading: a 31078 with a `blob` tag whose content opens to `{` is a pointer
  (core ingest item `{bytes: "", blob: {hash, sha256, size, key, url?}}`;
  the harness parses it the same way). The reader GETs the blob from `url`,
  else `<Blossom server>/<sha256>`, checks sha256 and size, decrypts, and
  the plaintext must be a base whose `base_hash` is `hash` (core
  `base_open_blob {hash, bytes}` → `{bytes, base}`; the harness compares
  sha256 of the plaintext, writers never serialize field 8). Then it is
  imported exactly like an inline base (authorization included). A fetch or
  verification failure imports nothing: the replica leaves the event unheld
  (asked for again) with a replay fault; the harness records a replay fault.
  A pointer whose version is not 1, whose fields are malformed, or whose
  `blob` tag names another blob/size is not an item (no fault: no later read
  can make it one).
- Deleting: when a compaction's NIP-09 of the previous base reached every
  relay, the previous base's blob (recorded with our relay copy) is queued
  in `sync-state.json` `blobDeletes` and BUD-02 `DELETE /<sha256>`
  (BUD-11 `t=delete`) is sent; 404 counts as deleted. A refused delete stays
  queued and is retried every compaction pass; it never holds back the
  compaction (an orphaned blob only costs storage).
- Readers older than pointers: the content is not base64, so the core's
  part check drops it (web/iOS: "decrypt failure", the event stays unheld
  and is asked for again; nothing is imported) and an old harness's daemon
  import refuses it (logged, a replay fault). They keep the object's previous
  state: they never mis-parse the pointer as a base. Until they upgrade they
  miss that one object's newer base (its deltas on it look stale to them).

## Sync on a device

1. **Bases first.** NIP-77 reconcile `{kinds:[31078], authors:[me]}` plus
   each space stream (`#h`), fetch missing bases and their 1080 parts (or,
   for a pointer base, its Blossom blob).
   Every object renders from its base as soon as it lands.
2. **Live deltas.** For objects whose base is held: reconcile
   `{kinds:[1078], #b:[...current base hashes]}` in batches, plus deltas of
   objects with no base (`#h` object tags), plus each stream `since` its
   own floor. Streams are the personal stream (`authors:[me]`) and each
   shared space stream (`#h` space tag); a stream's floor is the newest
   base `created_at` among that stream's bases minus 1 day, and a stream
   holding no base is walked whole (since 0) exactly as before. Never a
   global floor: one stream's bases say nothing about another stream's
   unbased objects (a space whose owner's computer has not compacted yet).
3. **Unbased sweep.** The window in step 2 assumes every object older
   than its stream's floor has a base. That fails whenever no computer
   based an object (its serving computer offline, a harness whose unbased
   fallback skipped it), and such objects would never reach a fresh
   device. So, per relay and per stream holding a base, the replica
   reconciles the stream *below* its floor (`until` = floor) and fetches
   everything except the events of objects that hold a base: those ids
   are listed first by NIP-77 over the based objects' `h` tags (personal
   tag plus one per installed space key, `sha256(prefix || objectId)[..16]`),
   against an empty set, so nothing is downloaded for them. Relays without
   NIP-77 get a paged walk of the range instead. Progress is kept per
   stream in store meta `unbased-swept` (scope -> swept-up-to); a stream
   counts as swept only when every relay completed it, and later passes
   sweep only the range its floor moved past. A device that synced before
   the sweep existed runs it on its next pass. Known gap: a change
   published late with a `created_at` below an already-swept floor (a
   device catching up after days offline) is still missed, as by the live
   subscription.
4. **Live subscription** as today (`since = cursor+1`) on 1078, 31078,
   1080, 5.
5. Never walks a stream holding a base from event zero again; below the
   floor only the unbased sweep reads, and only events no held base covers.

Hosts: daemon + harness (`glonOdin`), and the Rust replica
(`RoostrWebsite/gpui/crates/roostr-replica`, `src/sync/history.rs`) shared
by the web app and the iOS app (`RoostrWebsite/gpui/crates/roostr-ios`,
hosted by `RoostrIOS`). The core (`core/`, linked natively and as WASM)
owns: base encode/decode/hash, current-base choice,
live/orphan classification, rebase change construction, replay from base,
sealing/opening bases.

Replica own marks (`roostr-replica-store`): a local write stores the
change, its publication obligation and meta `own:<changeId>` = object id in
one transaction; publishing removes only the obligation. After every import
batch and history pass (over the objects touched, plus every object with an
obligation or an own mark) `resolve_orphans` classifies with `pending` and
`own`, folds away (`mark_rebased`, which also drops own marks) the core's
`discard` and `proven` plus the own changes a held strict ancestor covers
by id, and rebases `rebase` (`add_rebased` moves the own mark to the copy).
Its requests strip what the base chain covers except covered changes
sharing author and timestamp with a held own change (edit-key copies).
Obligations imported from the Svelte store get own marks; an own change
published before this rule (no mark) is treated as another device's.

## Directories: drawing a vault before holding it

A device that holds only part of the vault (a "lite" replica: the web app
on roostr.space and the iPhone fetch objects as they are opened) draws the
sidebar, spaces, types, properties and per-type counts from two kinds of
ordinary synced objects (`core/directory.odin`, type `directory`, hidden from
untyped queries, object lists and the graph like the vanish ledger):

- `__directory__` (no `channel`: the personal stream) - one field
  `space:<spaceId>` per live space: Map `{name, icon, created}` (`icon` =
  `iconImage` when set, else `iconEmoji`; `created` = the space's createdAt),
  and one `device:<recordId>` per live device record: Map `{name, kind}`
  (below; `last_seen` stays out, so the directory changes only when a
  device appears, goes or is renamed).
- `__directory__:<spaceId>` (`channel` = the space, so it is encrypted and
  routed with it) - `pin:<id>` Map `{name, icon, type, order, collapsed}`
  per pinned object, `type:<id>` Map `{key, name, icon, layout, builtin}`,
  `rel:<id>` Map `{key, name, icon, format, hidden, builtin}`, and
  `count:<typeKey>:<device>` Int.

Both carry `name` "Directory" and, once a builder completed them, `version`
1; one without `version` is not ready. Seen through `object_to_json`, a
directory's `fields` is a JSON object: a Map entry is
`{"mapValue":{"entries":{"name":{"stringValue":"…"},…}}}` (every key
present, "" / false when unset), a count `{"intValue":N}`.

**Counts merge per device.** Objects of a type in a space = the sum of its
`count:<type>:*` fields. A device writes only its own field (`device` in
the mutation payload, stable per install - the daemon's `<data>/device-id`,
a replica's kv `roostr-device-id`; the author when absent; never holding
`:`, so the type key is everything before the last `:`). Concurrent writes
from different devices never touch the same field. Counted: live objects
(not binned, not vanished) except spaces and bookkeeping (`directory`,
`vanish_log`, `device`, `user_prefs` and the engine internals the clients hide);
types and properties count under `type` and `relation`.

**Kept in step by every mutation.** `mutation_plan` ends with
`directory_maintain`: each object the plan writes or vanishes (and each
space it leaves) is projected before (stored) and after (stored + the
plan), and the difference - entries set or deleted, the writer's counts
moved by the delta - lands on its directory in the same plan, split into
changes that each fit one relay part. Only directories the vault already
holds, never one of a space that is gone, never one the plan itself
writes. A new space's directory is built complete by `channel_create`.

**Rebuilt where the whole vault is held.** `directories_repair` (also the
last step of `bootstrap_space_defaults`, so every daemon start and full
replica rebuilds) creates missing directories, rewrites differing entries,
deletes stale ones, writes its own count fields as the truth minus the
other devices' fields and sets `version`. Two devices building the same
directory at once merge into one object (fixed ids); their counts overshoot
until the next repair. A converged vault plans nothing.

**A lite replica** (`RoostrWebsite/gpui/crates/roostr-replica`,
`src/sync/lite.rs`). A replica decides once, on its first start, whether it
holds the vault whole (device kv `roostr-holding` = `full`) or in part
(`lite`): the browser and the iPhone start lite when their store holds
nothing yet; a store that already holds a vault (the Svelte import, the
Swift app's) stays full. A lite session:

- walks whole only the streams it holds whole (store meta `lite-scopes`:
  the personal stream, and shared spaces by id); every other object it
  holds is followed by its own blinded `h` tag - in each history pass
  (`{kinds: DAG, #h: [...]}` since the persisted cursor) and on the live
  subscription and the watchdog's head check;
- fetches on start the personal directory and the vanish ledger, every
  installed or listed space object with its directory, the device records
  the personal directory lists (and those it lists later, as it changes),
  then the `type:` and `rel:` objects the space directories list; the
  sidebar draws every space and its pins from the directories for what is
  not held (an unheld pin is an object summary from its `pin:` entry);
- fetches an object by id when it is opened (or a mutation plan names it):
  `#h` under the personal tag and every installed space key's, bases first
  (and their 1080 parts), then of an object holding a base the deltas on it
  (`#b`) and those since its base's day, of any other its whole history; it
  is followed from then on under the tag it answered to;
- loads a space whole on demand: a shared space adds its stream, any other
  space makes the personal stream whole (every unshared space syncs there);
- never seeds the bundled catalog or repairs directories (both read the
  whole vault), never reports `bootstrapped`, and never publishes a space's
  write allowlist before it holds the space object (its members);
- writes its directory counts under `device` = kv `roostr-device-id`;
- becomes full on "Fully sync this device" (`roostr-holding` = `full`, a
  bootstrap walk as on a fresh device), and at once when the relays hold no
  event of the identity at all (a new key: nothing to leave out).

**Device records** (`core/device.odin`). Every device of the account keeps
one personal object (no `channel`) under `__device__:<deviceId>` (the same
device id as its counts), type `device`, hidden like the directories:
`name` (auto: "Chrome at roostr.space", "iPhone", "Desktop app on
<host>", a daemon's computer name), `name_custom` (true once a person
renamed it: the auto name never replaces it), `kind` (`engine`, `browser`,
`iphone`, `desktop`), `holding` (`full`/`lite`), `percent` (0-100) and
`last_seen` (epoch ms). The device writes it with the `device_seen`
mutation (`object_id`, `name`, `kind`, `holding`, `percent`): on start,
when what it holds changes, and on a timer; the planner writes only the
fields that differ, and `last_seen` alone at most every 30 minutes
(`DEVICE_SEEN_MS`), so a running device does not churn the change log.
The daemon writes its own (always `full`, 100%) from `src/device.odin`; a
replica from its backend. `device_rename` sets `name` and `name_custom`;
removing one is a plain `delete`, which its device undoes the next time it
runs (Object_Create revives it; `purge_deleted` never vanishes a device
record, which would forbid that). Settings lists them ("Your devices") by
a typed query; `/api/settings` and a replica's settings carry `deviceId`
so this device's row is marked.

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

Decisions (RoostrRelay implementation):

- Uploader claims live in `blobs/<sha256>.meta` sidecars, not SQLite (the
  relay's store is its own event log; no SQLite dependency was added).
- Same bytes uploaded by several pubkeys keep one blob with one claim each;
  `DELETE` drops the caller's claim (403 if it has none) and the bytes go
  with the last claim. `GET /list/<pk>` must be signed by `<pk>`.
- Auth `created_at` may be up to 60 s ahead (device clock skew); an
  `expiration` tag is required. With an empty static allowlist the relay
  is open, so any signer may upload, as with events.
- Uploads require `Content-Length` (chunked is 411); `X-SHA-256` disagreeing
  with the body is 409; an `x` tag not covering the body hash is 401.
  `HEAD /upload` (BUD-06) preflights with `X-SHA-256`/`X-Content-Length`.
- Descriptor `url` is `<proto>://<Host>/<sha256>` (no extension; blobs are
  ciphertext), or `BLOSSOM_PUBLIC_URL/<sha256>` when that is set.

## Rollout

1. Core + tests; relay (31078/1080 acceptance, `#b`/`#c` indexing, Blossom).
2. Hosts read bases and live deltas and rebase their own orphans, while
   still accepting pre-migration history (dual read).
3. Computers start compacting (epoch 1 bases for every object).
4. Every device upgraded (web is live on deploy; iOS via TestFlight;
   every computer pulled and restarted) -> computers sweep pre-migration
   1078/1079 events from Roostr's relay.
5. Then imports (Anytype) publish epoch-1 bases directly.

## Computers: daemon and harness

### Daemon (`src/bases.odin`, `src/folded.odin`, `src/store.odin`, `src/sync.odin`)

Disk (`<GLON_DATA>`):

- `bases/<objectId>/<hash>.pb` - every held base, bytes as received, named
  by `base_hash` (damage goes to `bases/.quarantine/`). Retention after any
  base lands, and over every based object at serve start: the current base,
  one ancestor through `prev_base` (`BASE_KEEP_ANCESTORS`), same-epoch
  siblings, and every epoch-1 base; older ones are deleted. Epoch-1 bases
  stay because `POST /api/bases/covered` answers the harness's pre-migration
  sweep from their `covered_ids` (and the core's `premigrationCovered`
  reads them); state does not need them. Dropping an ancestor only ever
  turns what it folded into *stale*, never *orphan* (core Decisions). With
  one ancestor held, a change written on the base two epochs back is still
  decidable (the ancestor's `prev_base` names it); one written on an older
  base is stale unless its writer still holds it pending and rebases it.
- `changes/<objectId>/<hex>.b` - the base hash the change's event carried
  (imports) or the object's current base at commit time (local commits);
  `<hex>.local` - written on this computer and not yet proven folded (the
  core's `own`); `<hex>.published` beside it - that own change is confirmed
  on the relays. Pending (the core's `pending`) = `.local` without
  `.published`. `.b` and `.local` are written before the `.pb`; both
  markers go with the change when it is folded away, which for an own change
  happens only once proven folded (a held strict ancestor folded it:
  retention; or an older device's copy of it was: on load). Existing
  `.local` files keep their meaning (own, unpublished): no migration.
- `folded/<objectId>` - the folded-id index: one fixed 64-byte record
  `[id 32][rebased 32]` per change that left the working set - everything a
  held strict ancestor of the current base folded (ids never held here
  included, recorded before that ancestor may be deleted), another device's
  orphan/stale leftovers and own changes proven folded (on load: the core's
  `discard` / `proven`), and rebased own orphans, whose `rebased` names the
  replacement (zero otherwise). Append-only, fsynced before the change's
  `.pb`/`.b`/`.local`/`.published` are deleted; a torn last record (crash
  mid-append) is ignored on read and cut off by the next append. Never
  published or read for sync: an import of an indexed id is skipped, never
  written back into `changes/` - including a dropped ancestor's fold
  arriving late from a slow relay. Vanish purges `bases/<id>` and
  `folded/<id>` too.
- `archive/` (older daemons: hard links of every change ever written plus
  `<hex>.rebased`) is folded into the index once at serve start
  (`migrate_archive`): per object, the archived ids no longer held in
  `changes/` (or its quarantine) and every `.rebased` mapping are appended,
  then `archive/<objectId>` is deleted. Idempotent and resumable; it logs one
  summary line (`objects, ids, MB freed`). A change that left `changes/` any
  other way (quarantine) is no longer refused at import, so a good copy can
  heal it.

Object state everywhere (objects API, queries, the state cache) is the core's
base replay: current base + live deltas, or every change (over a legacy 1079
checkpoint) when no base is held. The legacy `/api/checkpoints` endpoints are
unchanged.

HTTP (POSTs are service-only, like `/api/checkpoints`):

| Endpoint | Does |
|---|---|
| `GET /api/bases` | per object: `hash` (`""` without a base), `epoch`, `createdAt`, `prevBase`, `bases`, `changes`, `live`, `liveBytes`, `oldestMs`, `covered`, `premigrationCovered`, `orphan`, `stale`, `pending`, `own` (held `.local` changes), `rebase` (own orphans: `POST /api/bases/rebase` has work), `compact`, `reason` (core thresholds) |
| `GET /api/bases/<id>` | held bases newest first `{hash, epoch, createdAt, prevBase, current, b64}` |
| `POST /api/bases` | import `{bases: [b64], provenance?}` (space bases: owner only, `authorizeBase` rules) → items `{objectId, hash, epoch, createdAt, prevBase, stored, current}` |
| `POST /api/bases/build` | `{objectId, force?}` → core `compact_plan`; when due the new base is stored (now current) and returned with `folded`. 409 `history incomplete` for an epoch 1 over a DAG with missing parents. 409 `compaction is off on this computer` when the daemon's environment has `GLON_STATE_SYNC_COMPACT=0` (the supervisor gives daemon and sync the same environment): a base sync never publishes would hold the changes it folded only locally |
| `POST /api/bases/seal` | `{base, conversationKey, space?}` → core `seal_base`; personal bases get the secret from `nostr.json` |
| `POST /api/bases/rebase` | `{objectId, orphans?}` → own orphans only: rebased changes written (with `.b`, `.local`: own and pending), orphans folded (index maps each to its rebased id). A rebased id already held without `.local` (an identical copy imported) gets `.local` + `.published`: it carries this computer's edit now |
| `POST /api/bases/covered` | `{objectId, ids}` → `{premigration, covered}` (ids folded by a held epoch-1 base / by any held base) |
| `POST /api/changes/published` | `{published: {objectId: [hex]}}` → `{ok, marked}`: writes `.published` beside each `.local` (no longer pending, never re-published); `.local` stays until a held base proves the change folded |
| `GET /api/changes/<id>` | rows add `b`, `pending`, `own`, and `class` (`live`/`covered`/`premigrationCovered`/`orphan`/`stale`) when a base is held |
| `POST /api/changes` | items may be `{b64, b}`: `b` is stored with the change; `reasons` says why each rejected item was refused (the sync logs it once per event) |

### Harness (`harness/src/nostrsync.ts`)

- Startup: bases first (`{kinds:[31078], authors:[me]}` + each space stream
  by `#h`, then their 1080 parts by `#c`), imported through the chunk-aware
  path. No base on the relays or held (pre-migration vault): the full
  history walk exactly as before. Otherwise the walk is bounded: live deltas
  by `#b` (batches of 100 hashes), the whole stream of every local object
  without a base and of the vanish ledger (which never gets one), and our
  stream and each space stream `since` that stream's own newest base minus a
  day - a stream with no base held is walked whole. The live
  subscription, watchdog and catch-up read 1078, 1079, 31078, 1080 (and 5)
  and never ask for less than the lowest stream floor. The persisted published set is
  kept in bounded mode (folded deltas are gone from the relays on purpose).
  REQ paging stands in for NIP-77 reconciliation (one 31078 per object).
- Deltas go out with `["b", <base>]` from the daemon's `b`; only `live`
  (or unclassified) working-set changes are published. A published pending
  change is confirmed to the daemon, which marks it published and keeps it
  own (confirmation is not "forget").
- Own orphans: every pass (and whenever a newer base lands) the daemon
  rebases those of objects whose row has `rebase` > 0 - personal objects
  always, a space's only for a writer of it - and the rebased changes are
  published. Another device's orphans are never rebased here: the daemon
  folds them away when it loads the object.
- Compaction (on unless `GLON_STATE_SYNC_COMPACT=0`; replaces the 1079
  checkpoint loop, which otherwise runs as before and skips objects that
  hold a base): at startup and every 10 minutes, for each object this
  computer compacts - `servesHere`, or, for an object nobody serves (no
  pin, no agent), the roster's smallest machine id, so every object gets a
  base; shared spaces only when this identity owns the space - that the
  daemon reports due, plus (unbased fallback) every object with no base
  whose oldest change is older than 12 h whoever serves it, built with
  `force`: build, seal (parts first, then the 31078), and once
  every relay accepted every event NIP-09: the folded deltas (`e`, k 1078,
  ≤ 254 per request; event ids from what was imported or published, else
  read back from the previous base's `#b` stream) and our previous copies
  at the address (`a` = `31078:<pubkey>:<d>` dated one second before the new
  base so it survives, plus `e` for their events, k 31078/1080). Epoch 1
  deletes nothing: what it folded is pre-migration. The cleanup is
  persisted (`compactions` in `sync-state.json`) and retried until every
  relay accepted it; if another base wins first it is dropped, deleting
  nothing. Every pass also publishes any held current base the relays lack
  (no recorded relay copy of that hash, or its own compaction not yet out everywhere) for
  every object, compacted here or not - e.g. one built by hand with
  `POST /api/bases/build`.
- Pre-migration sweep (`GLON_STATE_SYNC_SWEEP_PREMIGRATION`, default off):
  `dry-run` logs how many untagged 1078s an epoch-1 base folded and how many
  1079s of every object holding a base; `1` (needs compaction on)
  deletes them, per object, until every relay accepted.

### Files (`harness/src/blossom.ts`, `harness/src/files.ts`)

An upload is encrypted (fresh key, 4 MiB AES-256-GCM frames, nonce = frame
index big-endian) and PUT to the Blossom server - `GLON_BLOSSOM_URL`, else
the first configured relay whose NIP-11 lists `blossom`, else
`https://roostr-relay.fly.dev` - with a kind-24242 authorization; the File
gets `blob_sha256`, `blob_key`, `blob_url`. A failed upload leaves the File
peer-to-peer only. Reading: local store, then peers, then Blossom (decrypt,
check `file_hash`, keep locally). `GLON_BLOSSOM_BACKFILL=1` uploads every
local File lacking `blob_sha256` once at file-peer start.

## Core API

Every host reaches these through the existing core boundary:
`dispatch("sync", {action, ...})` (WASM `core_execute` in the browser, the
static library linked by `roostr-engine` on desktop/iOS, the
native daemon). Implementation: `core/state_sync.odin` (classification,
replay, rebase, planner), `core/wire.odin` (sealing), `core/sync_session.odin`
(ingest), `core/authority.odin` (authorization). Errors come back as the
usual dispatch error string. Hex ids/hashes below are abbreviated.

Shared request fields:

- `bases`: base64 `Checkpoint` protobufs (epoch >= 1) the device holds for
  ONE object - the current one and any superseded ones still held (holding
  more of the chain makes more orphans decidable, see Decisions).
- `changes`: `ChangeJSON` (as `codec`/`replay` use) plus `"b": "<hex>"` when
  the change's event carried a `b` tag (absent = pre-migration).
- `pending`: hex ids of changes this device has never published.
- `own`: hex ids of changes written on this device that no held base has
  proven folded yet, published or not (`classify`, `rebase`; pending ones
  count as own without repeating them).
- `checkpoint`: a legacy kind-1079 checkpoint (base64), only used when
  there is no base (exactly like `replay`).

All bases and changes must belong to one object.

### `base_decode`

```json
{"action":"base_decode","base":"CgVvYmotMRIg…"}
→ {"objectId":"obj-1","hash":"5e50…","epoch":2,"prevBase":"a1b2…","createdAt":1760000000000,
   "headIds":["f315…"],"covered":3,"coveredIds":["…","…","…"],"state":{ObjectJSON}}
```

### `base_current`

```json
{"action":"base_current","bases":["…","…"]}
→ {"index":1,"hash":"5e50…","epoch":2}          // null when no base
```

### `classify`

```json
{"action":"classify","bases":["…"],"changes":[{…,"b":"5e50…"},{…}],"pending":["9f0c…"],"own":["7d1e…"]}
→ {"base":{"hash":"5e50…","epoch":2},            // null: no base, every change is live
   "live":["…"],"covered":["…"],"premigrationCovered":["…"],
   "orphan":["…"],"stale":["…"],"liveHeads":["…"],
   "rebase":["7d1e…"],"discard":["…"],"proven":["…"]}
```

Hosts replay `live`, rebase `rebase` (own orphans), fold away `discard`
(another device's not-live leftovers, never rebased) and `proven` (own
changes a held strict ancestor folded: drop the own marker), may archive
`covered` / `premigrationCovered`, and keep an own `stale` change held with
its marker (never replay, never publish, never rebase).

### `replay_from_base`

```json
{"action":"replay_from_base","bases":["…"],"changes":[…],"pending":[…],"checkpoint":null}
→ {ObjectJSON with heads}                        // null when nothing is held
```

Current base state + live deltas in Kahn order; with no base, identical to
`replay` over every held change.

### `rebase`

```json
{"action":"rebase","bases":["…"],"changes":[…],"pending":[…],"own":[…],"orphans":["…"]}
→ {"base":"5e50…",
   "changes":[{"orphan":"7d1e…","id":"c09a…","change":{ChangeJSON},"bytes":"CiDA…"}]}
```

Only own orphans (`own` ∪ `pending`) are rebased; `orphans` is optional
(default: every own orphan) and narrows that set. Output is in publish order.
Publish each through the outbox with `base` = the returned hash
(`outbox_enqueue {pending: {…, base}}` or `wire seal {…, base}` add
`["b", hash]`), then mark the orphan rebased locally and move its own
marker to the copy. The same holdings produce the same ids.

### `compact_plan`

```json
{"action":"compact_plan","bases":["…"],"changes":[…],"nowMs":1760000000000,
 "pending":[…],"checkpoint":null,"force":false}
→ {"compact":true,"reason":"deltas","live":20,"liveBytes":5120,"oldestMs":1759990000000,
   "orphans":0,"stale":0,
   "base":"CgVvYmo…","hash":"77aa…","epoch":3,"prevBase":"5e50…","folded":["…"]}
```

`reason`: `deltas` | `bytes` | `age` | `forced` | `""`. `base`, `hash`,
`epoch`, `prevBase`, `folded` only when `compact`. After publishing the base
(below) to every relay, delete the `folded` deltas and the previous base.

### `seal_base` (also `dispatch("wire", {action:"seal_base"})`)

```json
{"action":"seal_base","base":"CgVvYmo…","conversationKey":"02…",
 "secret":"01…"}                                // or "space":{"keyHex","spaceId","owner"}
→ {"hash":"77aa…","objectId":"obj-1","epoch":3,"d":"3b9e…","gid":"b68d…",
   "event":{"kind":31078,"content":"…","tags":[["d","3b9e…"],["h","5f9c…"],["epoch","3"],["c","b68d…","0","2"]]},
   "parts":[{"kind":1080,"content":"…","tags":[["h","5f9c…"],["c","b68d…","1","2"]]}]}
```

Sign and publish every `parts` event before `event`. `gid` is `""` and
`parts` empty for a single-part base (no `c` tag).

### Deltas on a base

`wire seal` and `outbox_enqueue` accept `base` (hex): the sealed 1078 parts
carry `["b", base]`.

### Ingest

`ingest` now also takes kinds 31078 and 1080. A completed base yields

```json
{"item":{"bytes":"<base64 Checkpoint>","base":{"objectId":"obj-1","hash":"77aa…","epoch":3,
  "prevBase":"5e50…","createdAt":…,"headIds":["…"],"covered":20},
  "chunkKey":"…","provenance":{"spaceId","keyId","signer"}}}
```

(`chunkKey` when split, `provenance` for space objects; settle it like a
checkpoint group). A 1078 item carries `"b":"<hex>"` when its event had one;
hosts must store it with the change and pass it back in `changes[].b`.

### `authorizeBase`

```json
{"action":"authorizeBase","base":"CgVvYmo…",
 "provenance":{"spaceId":"space-1","keyId":1,"signer":"abab…"},
 "space":{"spaceId":"space-1","keyId":1,"owner":"abab…"},"trustedSpace":null,"existing":null}
→ {"ok":false,"reason":"only the space owner may publish bases"}
```

Same rules as `authorizeCheckpoint` (owner only, state scoped to the space,
type unchanged); a base of epoch 0 is refused.
