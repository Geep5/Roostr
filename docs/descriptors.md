# Everything describes itself: protobuf descriptors

Status: proposal for review. Replaces the object-shape half of
`docs/skills-and-integrations.md` with a schema-first version.

## The complaint, in one line

A client should be able to open a vault it has never seen, read what is there,
and know how to work it — without a table of hard-coded knowledge compiled in.

Today it cannot, because Roostr speaks **three** formats and only one of them
is shared:

| layer | format | who agrees on it |
| --- | --- | --- |
| changes on disk / on relays | **protobuf** (`glon.proto`, 37 messages) | everyone — daemon, browser, iOS |
| host ↔ core calls | **JSON** (`coreCall(method, payload)`) | everyone, expensively |
| what a skill or login *is* | **TypeScript literals** in the harness | only the harness |

That third row is the problem. `CREDENTIALS` and `CATALOG` live in
`harness/src/*.ts`, so the website keeps a hand-copy:

```ts
/** Mirrors the harness catalogs (harness/src/skillmgr.ts CATALOG plus
 *  harness/src/credentials.ts CREDENTIALS): the only capability keys a
 *  machine can publish. */
export const CAPABILITIES = [
  { key: "browserless", label: "Headless Chrome" }, …
```

Two lists, two languages, one meaning — kept in step by hand. Every mismatch
we hit this week was this shape of bug (a type hidden on one host and listed on
the other; a machine visible in the browser and invisible on localhost).

## ELI5

Right now the desktop client is like a **waiter who has memorised the menu**.
It works until the kitchen changes something, and then it confidently tells you
about a dish that no longer exists.

What you want is a waiter who **reads the menu off the table**. The kitchen
prints the menu; the waiter renders whatever is printed. Add a dish tomorrow
and every waiter — desktop, phone, the ones written next year — describes it
correctly without being retrained.

A **descriptor** is that printed menu card. It is not the food (that is the
secret, and it stays in the kitchen). It is not the order (that is a mutation).
It is: *this thing exists, here is what it needs, here is how you check it,
here is what it is called.*

Three kinds of card, and the difference matters:

- **Descriptor** — "an X (Twitter) login needs 4 fields; two are secret; it
  authenticates by browser profile or by API key." Published once, by whoever
  knows how the thing works.
- **Installation** — "on Mac, X is active, as @matcherino, checked 3 minutes
  ago, no error." Published by that machine, about itself.
- **Secret** — the actual key. **Never printed. Never in the DAG.**

The client then has one job: read cards, draw them, and send mutations when the
human acts. It never needs to know what "X" is.

## Why protobuf specifically, and not just object fields

Objects already hold arbitrary fields, so descriptors *could* be plain fields.
Protobuf earns its place for three reasons that matter here:

1. **Forward compatibility is a guarantee, not a hope.** Unknown fields
   survive a decode/encode round trip. A phone built today can read a
   descriptor written next year, render the parts it understands, and pass the
   rest through untouched — including re-publishing it without corruption.
   Hand-rolled JSON in fields gives you none of that; an old client silently
   drops what it does not recognise.
2. **One definition, all three languages.** Odin (daemon + WASM core), the
   browser, and Swift already generate from `glon.proto`. A descriptor added
   there is instantly typed in all of them. A TypeScript literal is typed in
   exactly one.
3. **It is already the wire.** Changes are protobuf; content addressing is
   `sha256(proto3-encode(change with zeroed id))`. Descriptors travelling as
   proto bytes inside a change are the same shape of thing as everything else
   — no second encoding to keep honest.

## The shape

New messages in `glon.proto` — descriptors, plus the state that answers them:

```proto
// What a thing needs. Published once; read by every client.
message Descriptor {
  string key         = 1;   // "x", "browserless", "google"
  string name        = 2;   // "X (Twitter)"
  string description = 3;
  Kind   kind        = 4;   // SKILL | INTEGRATION
  repeated FieldSpec fields  = 5;   // what a human must supply
  repeated AuthMethod auths  = 6;   // browser profile, oauth, api key
  CheckSpec check            = 7;   // how a machine proves it works
  InstallSpec install        = 8;   // how a machine acquires it
}

message FieldSpec {
  string key    = 1;   // "apiSecret"
  string label  = 2;   // "API secret"
  bool   secret = 3;   // never leaves the machine
  Format format = 4;   // text | password | url | email
}

// What is true, on one machine, right now. Published by that machine.
message Installation {
  string key        = 1;   // descriptor key
  string machine_id = 2;
  Status status     = 3;   // ACTIVE | NEEDS_AUTH | MISSING | BROKEN
  string account    = 4;   // "@matcherino", "support@matcherino.com"
  AuthMethod auth   = 5;   // which one it actually used
  int64  checked_at = 6;
  string error      = 7;   // mirrored onto the object's `error` property
}
```

Both ride in the DAG the ordinary way: one object per descriptor, one per
installation, with the message as its payload. The generic object model still
works — lists, links, views, the `error` badge — and a client that wants
detail decodes the message instead of guessing at fields.

**Secrets are structurally absent.** `FieldSpec.secret` says "a value exists
for this, on that machine"; the value lives in `credentials.json`, a browser
profile, or a `gws` config dir. There is no field in the schema that could
carry it, which is stronger than a rule saying nobody should.

## What the desktop client can then infer

Given descriptors + installations, and nothing else compiled in:

- **Render a setup form it has never seen.** `FieldSpec[]` is a form: labels,
  which inputs are passwords, which are URLs. A new integration appears in the
  UI the day the descriptor lands — no client release.
- **Explain the state of the workshop.** "X is active on Mac as @matcherino;
  needs auth on geepOmenComp" is two `Installation` messages, not a panel that
  knows what X is.
- **Show what is broken, in views.** `Installation.error` mirrors onto the
  object's bundled `error` property, so "everything broken anywhere" is a saved
  query — the machine-local holdup that is invisible today
  (`credential "x" has no logged-in browser profile`, seen 3 times) becomes a
  row you can sort.
- **Route work honestly.** `requires_auth` already resolves against local
  files; against installations it can answer "no machine here has X, the Studio
  does" — which is what the `<capabilities-elsewhere>` prompt wants to say.
- **Describe local agents the same way.** An agent is already an object; a
  descriptor for its model, tools and prompt sections lets a remote client show
  *what that agent can do* without the harness explaining itself over a side
  channel.

## The part I would push on

"Everything runs off protobuf" has a second half, and it is the one with
numbers behind it: **the host ↔ core ABI is JSON.** Measured today:

- every view query re-serialised the whole corpus with `JSON.stringify` —
  26 ms at 20k objects, seconds beyond that (now fixed by sending only the
  delta, but the *encoding* is still JSON);
- the ABI rejects any request over 16 MiB, which is why a cold start had to be
  split into batches;
- the core's cache arena gives out around 20 MB of object JSON, because a
  parsed JSON allocation carries a header per value.

All three are JSON-at-the-boundary costs. Protobuf on the ABI would cut the
encode/decode, remove the string-parse arena overhead, and raise the practical
vault ceiling — the same win the descriptor work wants, on the path that is
actually hot. It is also the bigger change of the two, so: descriptors first
(they unblock the product), ABI second (it unblocks scale).

## Phases

1. **Schema.** `Descriptor`, `FieldSpec`, `AuthMethod`, `CheckSpec`,
   `InstallSpec`, `Installation` in `glon.proto`, with fixtures — the parity
   runners already gate the three implementations against each other.
2. **Publish descriptors from the existing catalogs.** `CREDENTIALS` and
   `CATALOG` become the *seed* for descriptor objects rather than the runtime
   source of truth, exactly how `BUNDLED_TYPES` seeds types. The TS literals
   can then be deleted, and the website's hand-copy with them.
3. **Publish installations** where `publishCapabilities` already runs
   (`harness/src/machine.ts:123`): created on first boot, updated only on
   change. `machine.capabilities` stays as the derived flat list the serving
   resolver reads.
4. **Mirror failures onto `error`.** `fileHoldup` writes the installation's
   `error`; a clean check clears it.
5. **Generic client rendering.** The Machine panel stops knowing what X is and
   renders `FieldSpec[]`; the website's `CAPABILITIES` literal is deleted.
6. **Then the ABI**, on its own evidence.

## Decisions taken

1. **Descriptor payload: bytes; installation: fields.** As recommended.
   A descriptor is machine-authored and versioned, so it gets protobuf's
   unknown-field guarantee; an installation's `error`, `account` and `status`
   are view-facing, so they stay object fields where views, sorting and the
   bundled Error badge already work.
2. **Anyone may publish a descriptor** — power over safety, deliberately.
   Consequences, stated rather than papered over:
   - A descriptor drives what the UI asks a human to type. A hostile one can
     ask for a password under a plausible label. The rendering client must
     show `author` next to any credential form, and never pre-trust a key.
   - `CheckSpec.command` and `InstallSpec.prompt` are *descriptions of work*,
     not authorisation to do it. **Nothing executes on arrival.** A machine
     runs a check or an install only after a human enables that descriptor on
     that machine, per descriptor - the same shape of consent the skills
     manager already takes.
   - `key` collisions are first-writer-wins per space, and the author is part
     of the identity; two "x" descriptors from different authors are two
     cards, not a merge.
3. **Agents get descriptors too** (`DescriptorKind.AGENT`, in the schema now).
   The shape of an agent's card - model, tools, prompt sections - is the least
   settled part, so it lands after integrations prove the pattern.

## What exists now

Built and verified (`core/descriptor.odin`, `core/conversation.odin`,
`core/descriptor_json.odin`):

- the six descriptor messages plus `Conversation` in `glon.proto`;
- ONE codec, in the shared core, reached by every host through
  `dispatch` → `"descriptor"` (`encode`/`decode` × descriptor, installation,
  conversation). No host carries its own protobuf reader;
- unknown-field preservation proven across BOTH hops - bytes → JSON → bytes -
  because the ABI is JSON and a guarantee that stops at the host boundary is
  not a guarantee (`core/descriptor_test.odin`,
  `website/scripts/descriptor.test.ts`);
- many conversations per object: `conversation_open`, `chat_post thread_id`,
  `conversation_update`, with the legacy `__discussion__` root still reading
  as the human thread.

Remaining, in order: publish descriptors from the harness catalogs (deleting
the TS literals and the website's hand-copy), publish installations where
`publishCapabilities` runs, mirror holdups onto `error`, render `FieldSpec[]`
generically, then the ABI.
