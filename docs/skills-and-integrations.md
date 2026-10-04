# Skills, capabilities and credentials

What a computer needs to run an agent is three object types, each with one job:

| type | how many | written by | job |
| --- | --- | --- | --- |
| **Skill** (`skill`) | one per catalog key, shared | seeded by every harness; people edit the body | what the software is, and the instructions agents read |
| **Capability** (`capability`) | one per catalog key × computer | only the computer it names | that software's state on that computer, and the inbox for setup requests |
| **Credential** (`credential`) | one per signed-in identity | people; the computer in its Served by | a login: service logins, model logins, Google accounts |

There are no install rows, no descriptor cards and no per-machine capability
list: a machine object says only which computer it is.

## ELI5

Think of a workshop.

- A **Skill** is the *card on the wall*: "Headless Chrome — render pages and
  screenshots; here is how to use it." One card, everyone reads it.
- A **Capability** is the *tag on one bench's copy of the tool*: "on Mac,
  Headless Chrome works, checked 3 minutes ago." Each bench writes its own tags.
- A **Credential** is a *key on a hook*: "support@example.com". It says which
  door it opens and which bench looks after it, never the cut of the key in a
  way anyone else can read.

## Skill

Every catalog key (`CATALOG` in `harness/src/skillmgr.ts`) has a Skill object,
seeded at boot by `seedCatalog()` (`harness/src/catalog-seeds.ts`): found by
`key`, else by a matching name without a key (the key is then set), else
created. Its name is the catalog entry's `name`; that name is the label every
client shows. A Skill with a `key` is machine software: listing it in an
object's Skills routes the work to a computer with an active capability of that
key. A Skill without a `key` is instructions only.

Agent kinds (`PROMPT_SEEDS`) are seeded the same way, as agent Templates per
space carrying the kind's prompt link, Skill links and field defaults, and are
re-seeded only while unedited (the `credential-seeds.ts` pattern).

All three seed lists (`CATALOG`, `PROMPT_SEEDS`, `CREDENTIAL_SEEDS`) also take
the entries of private extensions: `harness/private/<name>/index.ts`, a
gitignored checkout loaded at boot by `harness/src/extensions.ts`, which can
also add per-service session renewers, signed APIs and credential-action code.
A computer without an extension seeds only the public lists and leaves
what an extension seeded elsewhere alone: seeding iterates its own entries,
and the boot migrations skip keys and kinds they don't know.

## Capability

Fields: `key` (catalog key), `served_by` (the computer's machine id, as a
string), `status` (`active`, `needs_auth`, `needs_approval`, `processing`,
`missing`, `broken`, `disabled`), `error` (the holdup or failure text, on the
bundled Error property), `checked_at`, `channel` (the integration space) and
`description`. `key` and `served_by` are protected fields.

- **Only that computer writes it.** `skillmgr` upserts this computer's
  capability (`upsertCapability` in `harness/src/capabilities.ts`) when an
  install, enable, disable, uninstall or check settles. One row per (key ×
  computer) means two computers never write the same field, and `error` can
  say exactly what is wrong where.
- **It gates serving.** The engine's `skill_servers(key)` is the set of
  computers with a non-deleted capability of that key whose `status` is
  `active` (`core/serving.odin`). Anything short of `active` is not offered —
  not to agents, not to the resolver.
- **It is physical.** A capability object resolves to its own `served_by`
  (reason `self`), so an agent's work on it happens on that computer.
- **Holdups land on it.** A blocked call sets the capability's `error`
  (`publishHoldup`) and the blocked object's `needs <key>:` badge; a heal
  clears both. A holdup never changes `status`.
- **It is the request inbox.** An agent asks a computer to act on a skill by
  messaging the capability object with an `operation`: `skill.install`,
  `skill.enable`, `skill.disable`, `skill.uninstall` or `skill.check`
  (`capability_request` tool, `roostr.requestCapability`). Such a message may
  come from any space and the capability's reply may cross back. Nothing runs
  on arrival: the owning harness marks the request `awaiting_approval`, the
  capability `needs_approval`, and a paired human on that computer approves
  or rejects it (`GET /capability-requests`, `POST
  /capability-requests/approve|reject` with `{objectId, messageId}` on the
  harness's local port).

Agents read every computer's capabilities through `capability_list` /
`roostr.capabilities()`: `{id, key, machineId, status, error, checkedAt,
channel}`.

## Credential

A Credential is one signed-in identity: service logins (seeded from
`CREDENTIAL_SEEDS` in `harness/src/credentials.ts`), model logins and Google
accounts (service `google-account`, `account` = the email). Its secret rides
on the Credential (`key_*`, `session`) and is materialized only on the
computer that serves an agent listing it.

`POST /credentials/connect|check|disconnect` with `{id}` on the computer in
the Credential's Served by. For a Google account, connect runs `gws-as
<account> auth login` there and imports the sign-in into the `key_*` fields;
check runs the live `gws-as <account> auth status`; disconnect clears the keys
and the local account folder so nothing re-imports it.

Tool code never sees those secrets: every object the roostr SDK hands a tool
(`get`, `getInSpace`, `writable`, `query`) shows a Credential's filled
`key_*`, `session` and `secret` fields as `[secret]` (`hideCredentialSecrets`
in `credentials.ts`). Only the harness acts with them. The daemon and the
website still see the real values.

### PostgreSQL (read-only)

Service `postgres` is a database an agent may query but not change. A human
fills in two fields:

- **Database URL** (`key_url`, secret): `postgres://user:password@host:port/database`.
  Give it a read-only database role. The harness enforces read-only access as
  well, but a role is the real guard.
- **SSH host** (`ssh_host`, optional): e.g. `root@1.2.3.4`. When it is set,
  the serving computer reaches the URL's host:port through its own tunnel,
  `ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -N -L 127.0.0.1:<free port>:<host>:<port> <ssh_host>`.
  That computer's ssh keys and `~/.ssh/config` must reach the host
  non-interactively. There is one tunnel per credential: it is reused while it
  lives, reopened when it dies, and killed when the harness exits.

There is no browser sign-in. Connect and Check run a live `select 1`, which
sets the status to active or broken (the error never contains the URL or
password). The slow refresh keeps the last result until the URL or SSH host
changes, and retries a broken credential every five minutes.

Agents use the built-in `sql_query` tool (`harness/src/tool-code/sql_query.ts`),
or `roostr.credentials.sql(service, sql, {credential, maxRows})` from tool code.
As with `credential_action`, permission is having the credential: the agent's
Credentials must list an active `postgres` credential, and `credential` (a name
or id) picks one when there are several. `harness/src/sql.ts` runs the query:

- It accepts exactly one SELECT, WITH, VALUES, TABLE, SHOW or EXPLAIN statement.
  Semicolons inside strings and comments are fine.
- The statement runs as a prepared statement in a `READ ONLY` transaction with
  `SET LOCAL statement_timeout = '30s'`, and the transaction is always rolled back.
- It returns `{columns, rows, rowCount, truncated}`: 500 rows by default and
  2000 at most (`max_rows`).

Put the database's schema in a Skill or guide that the agent reads.

## Migration

Each boot runs, in order (`harness/src/index.ts`): `migrateLoginInstalls`
(this computer's old login rows → Credentials), then `migrateCapabilities`
(`harness/src/migrate-capabilities.ts`), then `seedCatalog()`.
`migrateCapabilities` folds every legacy `install` row into the capability for
its (key × machine) — copying status, error, checked_at and channel — and
vanishes it (account-keyed Google rows just vanish; pending requests in their
inboxes go with them); turns a legacy machine `capabilities` list into
capability objects and deletes the field; keeps the earliest capability per
(key × machine); stores `served_by` as a string; drops `install`, `account`
and `auth` fields; and vanishes capabilities for sign-in keys. `seedCatalog()`
vanishes the retired `descriptor` cards. All three are idempotent.
