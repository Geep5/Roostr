# Computers (machine objects as a first-class type)

Status: proposed. Audit of what exists today plus the plan to finish it.

## What exists today

Every harness registers its host at boot (`harness/src/machine.ts:130`), so the
objects are already there — three of them:

| object | name | machine_id | capabilities | space |
| --- | --- | --- | --- | --- |
| `238d7746` | Mac | `820d3a06` | browserless, google, matcherino | Farwell Castle |
| `42958f34` | geepOmenComp | `70d3c047` | — | Farwell Castle |
| `61b360d1` | Grants-MacBook-Pro.local | `055b5775` | browserless, google | Farwell Castle |

They are invisible and mute for four separate reasons:

1. **No type object.** `BUNDLED_TYPES` (`core/mutate.odin:1147`) has no `machine`
   entry, so nothing appears in the sidebar's Types list and the objects have no
   type definition to open.
2. **Hidden on the daemon, visible in the browser.** `HIDDEN_LIST_TYPES` in
   `src/server.odin:300` includes `machine`; the browser's list in
   `src/lib/engine/backend.ts:338` does not. The same vault therefore lists
   machines on roostr.space and hides them on localhost.
3. **No discussion.** None of the three has a `__discussion__` block.
4. **No agent, by rule.** `UNMINTABLE` in `harness/src/index.ts:273` contains
   `MACHINE_TYPE`, so a machine object can never mint an agent — which
   contradicts `docs/object-serving.md`, where a machine's own harness answers
   its machine object ("install browserless", "why did X fail").

The space stamp is incidental: `create` falls back to the oldest channel
(`core/mutate.odin`, the `has_channel` fallback), which is Farwell Castle.

## Plan

### 1. Keep the type key, add the type object

Add to `BUNDLED_TYPES`:

```odin
{"machine", "Computer", "🖥️", "page"},
```

`machine` stays the type key. Renaming it would break `machine_id`/`served_by`
(protected fields in `core/authority.odin:39`), `control_type`, the serving
resolver (`core/serving.odin`), `UNSERVED_TYPES`, and the harness roster — all
keyed on the string `machine`. The human-facing name is what changes.

### 2. One hidden-list, both hosts

Drop `machine` from `src/server.odin:300` so the daemon and the browser agree.
Machines then appear in lists, search, and the graph on every surface.

### 3. Placement

Machines are device facts, not space content. Two options:

- **Canonical space (recommended).** Leave them in the default space and add a
  bundled saved view "Computers" (`typeKey = machine`) so they are discoverable
  without hunting. One list, one place to pin.
- **Per space.** Copies drift and there is nothing per-space about a device.

### 4. The chat

- Remove `MACHINE_TYPE` from `UNMINTABLE`.
- Mint on the first human message, exactly like any other object, but **only on
  that machine's own harness**: `resolve_server` must answer "itself" for a
  machine object. Verify `core/serving.odin` does this; if it does not, add the
  rule there (one place, every host) rather than in the harness.
- The agent's prompt already carries `<capabilities-elsewhere>`, credentials and
  holdups; a machine-bound agent should additionally get its own machine row
  (capabilities, holdups, skills installed here) so "install browserless" is
  answerable.
- Guardrail: `machine_id` and `capabilities` are written by the machine itself.
  The agent must not set them — they are protected fields, so authority already
  refuses any non-owner write, but the tool layer should refuse too, with a clear
  message instead of a rejected commit.

### 5. Verification

- Engine fixture: `resolve_server(machine_object)` = that machine, for a machine
  with and without capabilities.
- Harness test: a human message on a machine object mints exactly one agent, on
  the machine that owns it, and no other harness answers.
- Parity test: `/api/objects` and the browser's `fetchObjects()` return the same
  type set for the same vault (this is the asymmetry that hid them).
