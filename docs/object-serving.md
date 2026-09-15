# Per-object serving

Status: implemented. Supersedes the per-space rule in README "Sync (nostr)".

## Problem

Today one machine serves a whole space: `served_by` on the channel object
decides who mints agents, answers discussions, and fires occurrences for
everything inside it (`harness/src/machine.ts`, `spaceMine`). That is the
wrong grain in three ways:

1. **Capabilities are per machine.** browserless, gws, a checkout path — all
   live on one device (`~/.glon/skills.json`). An agent in a space served by
   the laptop cannot render a web page even though the studio Mac has
   headless Chrome; it files a holdup and stops.
2. **Recurring work follows the space, not the job.** A nightly scrape that
   needs Chrome fires wherever the space happens to be served.
3. **A human should be able to talk to any machine.** Which machine's
   harness does the work for object X must not decide which machine the
   human may use, or which machine's agents they may address.

## Model

Responsibility is a function of DAG state that every machine evaluates
identically. No heartbeats, no leases, no coordinator.

### Fields

| Object   | Field          | Type        | Writer                     | Meaning                                                |
|----------|----------------|-------------|----------------------------|--------------------------------------------------------|
| machine  | `machine_id`   | string      | that machine               | stable id from `~/.glon/harness.json`                  |
| machine  | `capabilities` | string list | that machine               | catalog keys installed **and** enabled here            |
| machine  | `name`         | string      | that machine / human       | hostname by default                                    |
| channel  | `served_by`    | string      | human, first-seen machine  | default server for objects in the space (unchanged)    |
| any      | `served_by`    | string      | human, agent tool          | pin: this machine serves this object                   |
| any      | `requires`     | string list | human, agent tool          | capabilities the work needs                            |

`served_by` is already a protected field (`core/authority.odin`
`protected_field`); `machine` is a control type — only the owner writes
either, which is every harness of the owner, since they share the key.
`requires` is ordinary data. The machine object's `claims` list is dropped:
it duplicated what the resolver derives.

### Resolver (engine, one implementation)

```
resolve_server(object, space, machines) -> { machine_id, reason }
```

Pure function in `core/serving.odin`, exposed through the ABI as method
`serving` (`resolve`), with fixtures in `core/serving_fixtures.json`. Every
host — harness, website, iOS — calls it; none re-implements it.

```
candidates = machines whose capabilities ⊇ object.requires
default    = object.served_by ?? space.served_by

if object.served_by set:
    if object.served_by ∈ candidates or requires empty → (served_by, "pinned")
    else                                                → (served_by, "pinned-uncapable")   # host files a holdup
if requires empty                                       → (default, "space")
if default ∈ candidates                                 → (default, "space-capable")       # stickiness: no churn
if candidates non-empty                                 → (min(candidates by machine_id), "capability")
else                                                    → (default, "unsatisfied")         # host files a holdup
```

Properties: deterministic across machines (same DAG → same answer);
adding a capability on machine B moves only objects whose current server
lacks it; a human pin always wins and is visibly flagged when it cannot
be honoured. The resolver never writes: responsibility moves by editing
inputs (`requires`, `served_by`, `capabilities`), each a normal commit.

### Agents follow their objects

```
server(agent) = resolve_server(agent.bound_object ?? agent, ...)
```

A bound agent (minted from an object's discussion) runs where its object
runs. An unbound agent (named by `assignee` on many objects) is itself an
object and resolves on its own row. `ScheduleHost.served(agentId)` in
`harness/src/index.ts` becomes `server(agent) == me`; `spaceMine` is
deleted and its callers (mint gate, drive gate, stand-down, roster
adoption) take the object-level answer.

### Recurring objects

`schedule.ts` `recurringMine()` filters by `resolve_server(obj) == me`
instead of `spaceMine(channel)`. Nothing else changes: `fired_for` is
still the idempotency key, so two machines that transiently disagree
(one has not yet synced a `requires` edit) cannot double-fire — the
engine refuses the second `occurrence_fire`. `arm()` re-runs on any
commit that touches `served_by`, `requires`, `repeat`, or a machine
object's `capabilities`.

### Skills

Catalog state stays device-local; what changes is that it is **published**
as `capabilities` and **consumed** by the resolver and the prompt.

- `skillmgr` publishes `capabilities` on this machine's object whenever
  enabled/installed state changes (a write only on change, like claims
  today). This is durable fact, not liveness.
- `listSkills(agentId)` lists catalog skills present on the **serving**
  machine (today: on the local machine — identical once agents follow
  objects), and adds a short section: *"Available on other machines:
  browserless (Studio). Add it with `object_require` to move this work
  there."*
- New agent tool `object_require(capability)`: appends to the current
  bound object's `requires`. The turn's closing text tells the human the
  work moved. The next message or occurrence is served by the resolved
  machine; pending unanswered messages are re-driven on adoption
  (existing `pendingMessages` path). No mid-turn migration.
- Brokered tools (`web_fetch`) keep filing holdups when the *serving*
  machine lacks the capability — that now only happens with a
  `pinned-uncapable` or `unsatisfied` resolution, and the holdup names it.

### Humans and machines

- **Every UI talks to the DAG, not to a machine.** A message typed on the
  laptop about an object served by the studio syncs and is answered by
  the studio. Already true; the spec makes it the stated contract.
- **Object header chip** (website `ObjectHeader`, iOS via the same web
  bundle): *"served by Studio · needs browserless"*. Click → machine
  picker (pin), clear pin, edit `requires` from the catalog list. Reason
  strings from the resolver drive the copy (`pinned-uncapable` and
  `unsatisfied` render as warnings).
- **Repeat cell** "runs on X" uses the resolver instead of the space's
  `served_by`.
- **Machine panel** lists per machine: capabilities, holdups, and what it
  serves (a query: objects whose resolution is this machine — computed
  client-side from `machines` + `channels` + candidate rows, no new
  index). Each machine object has a discussion; a machine's harness
  answers its own machine object (a machine always serves itself), so a
  human can address any machine directly: "install browserless", "take
  over the scrape task", "why did X fail" — from any device.

### Handover

On any commit changing an object's resolution (observed in the harness
commit loop, `index.ts` ~473 where `served_by` is handled today):

- the losing machine finishes the in-flight turn, drops the agent from
  `served`, and re-arms the scheduler;
- the winning machine adopts the agent into its roster, re-drives
  pending messages, re-arms;
- no ack between them; both act on the same commit. Convergence is the
  DAG's replay order, as for space takeover today.

Offline server: nothing runs for its objects (unchanged). Any device can
re-pin or edit `requires` to move the work; the previous server, on
return, sees the newer resolution before serving (sync first, serve
second — unchanged).

## Non-goals

- Liveness, leases, heartbeats, load balancing. A machine that is off is
  simply off; the human moves work by editing data.
- Mid-turn migration or cross-machine tool calls. Work moves between
  turns, never inside one.
- Phones serving anything. iOS renders the chip and the reminder copy
  only.

## Implementation plan

1. **Engine** (`glonOdin/core`): `serving.odin` resolver + ABI method +
   fixtures (pinned, pinned-uncapable, space default, capability move,
   stickiness, tie-break, unsatisfied, agent-follows-bound-object). Bundle
   `requires` relation. Rebuild `engine.wasm`, xcframework.
2. **Harness**: `capabilities` publish in `skillmgr`; `machine.ts` loses
   `spaceMine`/`claims`, gains `serverOf(objectId)` over cached machines +
   channels (20 s TTL as today, invalidated on relevant commits);
   `schedule.ts`, `index.ts` gates, `workspace.ts` binding check; `object_require`
   tool; prompt section for remote capabilities; machine-object discussion
   served by its machine.
3. **Website**: header chip + picker, Repeat cell, Machine panel "serves"
   list. iOS follows through the bundle.
4. **Cleanup**: README "Sync (nostr)" paragraph, `claims` field removal,
   `convergeSpaceServing` stays (space default is still the base case).

## Verification

- Engine fixtures for every resolver branch, run by the existing
  native/WASM/Swift parity runners.
- Two harnesses against the local relay (`relay7799`), machine A without
  browserless, machine B with: an object with `requires: [browserless]`
  and a daily repeat fires **only** on B (`fired_by`, `last_run.machine`);
  a message typed through A's UI is answered by B's agent; pinning to A
  produces a `pinned-uncapable` holdup on A and the chip warning; enabling
  browserless on A moves nothing (stickiness) until the pin is cleared.
- Reminders UI test on the simulator unchanged (reminders read
  `repeat.next`, not the server).
