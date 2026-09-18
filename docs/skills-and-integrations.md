# Skills and integrations as objects — plan (nothing built yet)

Status: proposal for review. Research of what exists, the shape I recommend,
and the one place the obvious design bites.

## Where things live today

| thing | where it lives | synced? | queryable? |
| --- | --- | --- | --- |
| skill instructions | `skill` objects (3 of them: `summarize-notes`, `browserless`, `google`) — `name`, `description`, `scope`, body in blocks | yes | yes |
| skill install state | `~/.glon/skills.json` → `{ installed, enabled }` per key | **no** | no |
| integration catalog | `CREDENTIALS` in `harness/src/credentials.ts` (x, matcherino, linkedin) — code, not data | n/a | no |
| integration auth | `~/.glon/credentials.json`, `~/.glon/browser-profiles/<key>`, `~/.config/gws/accounts/<email>` | **no (correct — secrets)** | no |
| what a machine can do | `machine.capabilities` — a flat list of keys | yes | barely |
| failures | `~/.glon/skills.json` → `holdups[]` (capability, agent, error, count, timestamps) | **no** | no |
| `error` property | bundled relation (`shorttext`, ⚠️), already used by the scheduler (`run failed: …`) and `object_flag_error` | yes | yes |

A real example on this Mac right now, invisible to every view:

```json
{ "capability": "x", "agentName": "Matcherino", "count": 3,
  "error": "credential \"x\" has no logged-in browser profile" }
```

So the instinct is right: **the state of skills and integrations is trapped in
machine-local JSON**, and the only thing that reaches the DAG is a flat list of
capability keys. You cannot ask "which integrations are broken?", "which
machines have X?", or "what account does each one use?" — and `error`, the
property that already drives badges and sorting, is unused here.

## ELI5

Think of a workshop.

- A **skill** is a *tool on the wall*: "headless Chrome", "Google CLI". The
  wall card says what the tool does and how to use it.
- An **integration** is a *key on a hook*: "the X account", "the Matcherino
  login". The hook says which door it opens and how it opens it — never the
  cut of the key itself.
- A **computer** is a *workbench*. Tools and keys are bolted to a bench, and
  two benches can each have their own copy of the same tool and their own key
  to the same door.

Today the wall cards are public (skill objects) but **which bench has which
tool, and whether it is broken, is written on a sticky note inside the bench
drawer** (`skills.json`) that nobody else can read.

The plan: put a small card on the wall for *every tool on every bench*, so you
can stand in the doorway and see the whole workshop at a glance.

## The shape I recommend

Two object types per concern, not one:

```
integration  "X (Twitter)"        ← what it is. One object. Hand-editable.
  └─ install "X on Mac"           ← written by Mac, only by Mac
  └─ install "X on geepOmenComp"  ← written by that box, only by it

skill        "browserless"        ← the instructions (already exists today)
  └─ install "browserless on Mac"
```

The install object carries, per machine:

| property | example | why |
| --- | --- | --- |
| `machine` | → Mac | the link that makes "2 machines have X" a query |
| `integration` / `skill` | → X (Twitter) | the other half of the link |
| `auth_method` | `browser_profile` \| `oauth` \| `api_key` | *how*, never the secret |
| `account` | `@matcherino`, `support@matcherino.com` | which identity, for `requires_auth` |
| `status` | `active` \| `needs_auth` \| `missing` | the answer agents need |
| `checked_at` | timestamp | so "active" has an age |
| **`error`** | `credential "x" has no logged-in browser profile` | the badge you already have |

Secrets never move. The install object says *how it authenticates* and
*whether it works*; the key itself stays in `credentials.json`, the browser
profile, or the `gws` config dir — the rule `docs/auth-requirements.md`
already sets.

## Where the obvious design bites

The tempting version is **one object per integration, with each machine's info
written inside it** — "X (Twitter)", marked by two machines. It breaks in three
ways, all from the same cause: two writers, one row.

1. **Same-field writes collide.** The DAG merges `field_set` by timestamp, so
   if Mac writes `status: active` and the dev box writes `status: needs_auth`,
   one silently wins. Per-machine maps inside one field make it worse: both
   machines rewrite the *same* map field, so the merge drops one machine's
   entry rather than blending them.
2. **`error` can only say one thing.** The whole benefit you are after is
   using the existing `error` property so a broken integration shows up in
   views. With one shared object, whose error is it? Nesting errors inside a
   map abandons the bundled property — and with it the sorting, filtering and
   badges you wanted for free.
3. **Serving is ambiguous.** Objects are answered by one machine (the resolver
   picks it). A per-machine install row answers itself — the same `self` rule
   Computers just got — so the box that owns the problem is the box that
   explains it. A shared object has no such owner.

One row per (thing × machine) costs more objects and makes "the overview" a
query instead of a single object. That is the right trade here, because the
overview *is* a query: `type = install AND error notEmpty` is your broken-
integrations view, and `integration = X` is your "which machines have X" view.

## What this unlocks

- **Views instead of a panel.** "Integrations needing auth", "skills that
  failed this week", "everything broken on the dev box" — all saved queries,
  because the data is objects with an `error` property.
- **Holdups become first-class.** The machine-local holdup above becomes an
  `error` on "X on Mac". It shows on the Computer's page, in the space, and in
  any view — instead of only in the Machine modal on that one machine.
- **Cross-machine answers.** `requires_auth` (already built) resolves against
  local files today. With install rows it can answer from the DAG: "no machine
  here has X; the Studio does" — which is what the existing
  `<capabilities-elsewhere>` prompt section wants to say.
- **Per-machine accounts, visibly.** Two machines, same integration, different
  accounts (`support@` vs `grant@`) stops being a guess.
- **A chat per install row.** Each install object can hold a discussion
  answered by its own machine: "why is X broken here?" answered by the box
  where it is broken.

## What stays as it is

- **`machine.capabilities` stays published.** The engine's serving resolver
  reads it (`core/serving.odin`), and the fixtures pin that. Install rows
  become the detailed truth; `capabilities` stays as the derived flat list the
  resolver needs. One source, two shapes.
- **`CREDENTIALS` / `CATALOG` stay in code.** They describe what Roostr knows
  how to install and which fields a login needs — that is program logic. The
  integration *object* is the human-facing card, seeded from the catalog the
  way bundled types are seeded.
- **Secrets stay machine-local.** Always.

## Phases

1. **Seed definitions.** Bundled `integration` type + one object per catalog
   entry (x, matcherino, linkedin, google), like `BUNDLED_TYPES` seeds Computer.
   Skill objects already exist and need nothing.
2. **Publish install rows.** Each harness writes its own rows where
   `publishCapabilities` already runs (`harness/src/machine.ts:123`) — created
   on first boot, updated only on change, exactly as capabilities are today.
3. **Move holdups onto them.** `fileHoldup` also sets `error` on the matching
   install row; a clean check clears it. The Machine panel keeps working,
   because it can read the rows instead of the JSON.
4. **Seed the views.** "Integrations", "Needs auth", "Broken" as bundled saved
   queries, so the paradigm is visible without anyone building a panel.
5. **Teach resolution.** `requires_auth` consults install rows first, local
   files second — so a missing integration can name the machine that has it.

## Open questions for you

1. **One `install` type, or `skill_install` and `integration_install`?** One
   type with a `kind` property keeps views simple ("everything installed
   anywhere"); two types make each list self-explanatory. I lean to one.
2. **Should install rows be hidden from normal object lists?** They are
   machinery and there will be dozens. I lean to hiding them from lists (like
   agent transcripts) and surfacing them through views and the Computer page.
3. **Who may edit an install row?** Machine-written, human-readable. If a
   human edits `account`, is that a request ("use this account") or a fact?
   A request is more useful — the machine reconciles it — but it needs a
   separate `desired_account` property to stay honest.
