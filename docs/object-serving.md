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
| machine  | `name`         | string      | that machine / human       | hostname by default                                    |
| install  | `machine_id`   | string      | owning machine            | fixed owner for local capability/authentication work  |
| agent    | `served_by`    | string      | human, harness migration   | the agent's machine: lends its pin to objects naming it |
| agent    | `repo_path`    | string      | human                      | "Project folder": the agent's checkout on that machine |
| any      | `served_by`    | string      | human, agent tool          | pin: this machine serves this object                   |
| any      | `agent`        | link list   | human, agent tool          | guest list; the first pinned guest lends its pin       |
| any      | `skills`       | link list   | human, agent tool          | skill objects the work uses (Skills)                   |
| skill    | `key`          | string      | harness catalog            | catalog key: the skill is software a computer installs |
| capability | `key`, `served_by`, `install` | links | that machine        | one catalog skill working on one machine               |

`served_by` is already a protected field (`core/authority.odin`
`protected_field`); `machine` is a control type — only the owner writes
either, which is every harness of the owner, since they share the key.
`skills` is ordinary data. A skill with no `key` is instructions only and
never constrains the machine; one with a `key` needs a machine with an
active capability of that key. People pick skills, never capabilities -
those are machine-side facts each harness publishes for itself.

### Resolver (engine, one implementation)

```
resolve_server(object, states) -> { machine_id, reason }
```

Pure function in `core/serving.odin`, exposed through the ABI as method
`serving` (`resolve`), with fixtures in `core/serving_fixtures.json`. Every
host — harness, website, iOS — calls it; none re-implements it. The ABI
payload is `{object, agents, machines, skills, capabilities}`: `agents` are the agent
objects the object's guest list names (any order; the list's order decides).
The space plays no part: machine choice lives on agents.

```
if object is an installation:
    return (object.machine_id, "self")                   # missing owner means unserved
if object is a machine:
    return (object.machine_id, "self")

needed     = keys of the skill objects object.skills lists (skills with a key)
candidates = machines with an active capability of every needed key
agent_pin  = served_by of the first agent in object.agent (list order) that has one

if object.served_by set:                                 # an agent object's own pin lands here
    if object.served_by ∈ candidates or needed empty   → (served_by, "pinned")
    else                                                → (served_by, "pinned-uncapable")   # host files a holdup
if agent_pin set and needed empty                       → (agent_pin, "agent")
if agent_pin ∈ candidates                               → (agent_pin, "agent-capable")
if needed empty                                         → ("", "unserved")
if candidates non-empty                                 → (min(candidates by machine_id), "capability")
else                                                    → (agent_pin ?? "", "unsatisfied")  # host files a holdup
```

Properties: deterministic across machines (same DAG → same answer);
adding a capability on machine B moves only objects whose current server
lacks it; a human pin always wins and is visibly flagged when it cannot
be honoured. The resolver never writes: responsibility moves by editing
inputs (`skills`, `served_by`, capability objects), each a normal commit.

Installation objects are the exception to general capability placement: their
`machine_id` is authoritative. A capability request cannot move a machine's
credentials or installation work to a different machine by changing
`served_by` or `skills`. Requests and results live in installation mailboxes;
the owner requires paired-human approval before local side effects.

### Agents are invited, then addressed

An object's `agent` property is its **guest list**: a link relation (format
`object`, typed to the space's `agent` type, many) naming the agents a
person - or one of those agents - may address here. Nothing answers an
object uninvited: a plain discussion post wakes nobody; an `@`-mention
sends a mailbox envelope to one guest, and only guests appear in the `@`
menu. There is no implicit "answered by" agent and no space-default
fallback for discussions.

Agents grow the list themselves: `object_set_field(id, "agent", <agent id>)`
appends (never replaces), so "ask Sarah about this" is add-then-`agent_ask`.
`agent_ask` refuses a recipient object whose guest list lacks another agent,
and an agent answering another agent may ask on, bounded to `A2A_MAX_HOPS`
(3) agent-authored messages per exchange. Co-guests on one object address
each other directly; the object's DAG holds both copies.

The object resolves through its guest list: without a pin of its own, the
first listed guest with a `served_by` lends it, and every guest runs where
the object resolves. The harness adopts each guest into its roster when it
serves the object (`adoptForObject`).

### Every agent names its own computer

An agent runs only where its own `served_by` says. An unpinned agent
resolves `unserved` whatever skills it lists - no capability fallback, no pin
borrowed from an object - and no machine runs it on any object either
(`agentRunsOn`). The engine keeps the reason on the agent's `error`
property (`core/agent_serving.odin`): `create`, `set_field`/`delete_field`
of `served_by`, and the boot converger set it on a pinless agent and clear
exactly that message once a pin lands. Subagents and external responders
are exempt.

### Recurring objects

`schedule.ts` `recurringMine()` filters by `resolve_server(obj) == me`
instead of `spaceMine(channel)`. Nothing else changes: `fired_for` is
still the idempotency key, so two machines that transiently disagree
(one has not yet synced a `skills` edit) cannot double-fire — the
engine refuses the second `occurrence_fire`. `arm()` re-runs on any
commit that touches `served_by`, `skills`, `repeat`, or a capability or
install object.

### Skills

Catalog state stays device-local; what changes is that it is **published**
as capability objects and **consumed** by the resolver and the prompt.

- `skillmgr` publishes one capability object per enabled catalog skill on
  this machine whenever installed/enabled state changes. This is durable
  fact, not liveness.
- Skills belong to the agent: its Skills narrow the instructions it sees
  (`listSkills`), and a machine skill its own computer lacks makes the
  agent `pinned-uncapable` - it holds and files a holdup rather than run
  without it. Objects carry no Skills of their own; work moves by pinning
  the agent to a computer that has them.
- Brokered tools (`web_fetch`) keep filing holdups when the *serving*
  machine lacks the capability — that now only happens with a
  `pinned-uncapable` or `unsatisfied` resolution, and the holdup names it.

### Humans and machines

- **Every UI talks to the DAG, not to a machine.** A message typed on the
  laptop about an object served by the studio syncs and is answered by
  the studio. Already true; the spec makes it the stated contract.
- **Object header chip** (website `ObjectHeader`, iOS via the same web
  bundle): *"served by Studio · needs browserless"*. Click → machine
  picker (pin), clear pin, edit Skills. Reason
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
re-pin or edit Skills to move the work; the previous server, on
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
   fixtures (pinned, pinned-uncapable, agent pin, agent-capable, guest-list
   order, capability move, tie-break, unsatisfied, unserved). Bundle
   `skills` and `repo_path` relations. Rebuild `engine.wasm`, xcframework.
2. **Harness**: `capabilities` publish in `skillmgr`; `machine.ts` loses
   `spaceMine`/`claims`, gains `serverOf(objectId)` over cached machines +
   channels (20 s TTL as today, invalidated on relevant commits);
   `schedule.ts`, `index.ts` gates, `workspace.ts` binding check; machine-object discussion
   served by its machine.
3. **Website**: header chip + picker, Repeat cell, Machine panel "serves"
   list. iOS follows through the bundle.
4. **Cleanup**: README "Sync (nostr)" paragraph, `claims` field removal,
   channel `served_by` removal (agents carry the machine choice).

## Verification

- Engine fixtures for every resolver branch, run by the existing
  native/WASM/Swift parity runners.
- Two harnesses against the local relay (`relay7799`), machine A without
  browserless, machine B with: an object whose Skills list browserless
  and a daily repeat fires **only** on B (`fired_by`, `last_run.machine`);
  a message typed through A's UI is answered by B's agent; pinning to A
  produces a `pinned-uncapable` holdup on A and the chip warning; enabling
  browserless on A moves nothing (stickiness) until the pin is cleared.
- Reminders UI test on the simulator unchanged (reminders read
  `repeat.next`, not the server).
