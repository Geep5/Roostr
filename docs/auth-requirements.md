# Auth requirements

Status: implemented. Defines how task objects declare which local identities an agent may use.

## Model

Keep four concepts separate:

| Concept | Meaning | Where it lives |
| --- | --- | --- |
| Capability | A machine can potentially do a kind of work | `machine.capabilities` |
| Account | Which identity inside a service | local integration config / `requires_auth` selector |
| Credential | Secret material proving that identity | local files only, never the DAG |
| Skill | Instructions for doing work | skill objects / prompts |

A task declares requirements; the serving machine fulfills them locally. Secrets never sync.

## Object properties

### `requires_auth` (tag / string list)

Required auth selectors. Entries are `service` or `service:account`.

Examples:

```text
x
matcherino
linkedin
google:support@matcherino.com
```

Rules:

- `google` is multi-account and MUST name an account.
- `x`, `matcherino`, and `linkedin` currently map to their configured local credential profile and do not take an account selector.
- `service` + `account` / `google_account` remain shorthand for the single-auth case, but new work should use `requires_auth`.

### `browserless` (checkbox)

Tool requirement, not auth:

- checked: use headless browser tooling for the web work;
- unchecked: do not use browserless;
- unset: agent chooses the safest path.

### `external_action` (checkbox)

Whether the task may perform an external write/action. Reads and preparation do not require it. Scheduled external writes should require it once enforcement is added.

## Resolution

For every scheduled or object-bound turn, the harness resolves `requires_auth` against local state:

- credential catalog (`x`, `matcherino`, `linkedin`);
- integration state (`browserless`);
- Google account dirs via `gws-as <account> auth status`.

Resolution is injected into the prompt as `<auth-requirements>`:

```text
<auth-requirements>
This object declares these auth requirements. Use exactly these identities; never substitute another account. If any is MISSING, file a holdup and do not complete the task:
- google:support@matcherino.com: active
- x: MISSING - x is not set up on this machine
</auth-requirements>
```

## Agent contract

Before acting, an agent MUST:

1. Read the resolved auth requirements.
2. Use exactly the listed identities.
3. Never substitute another account.
4. If any requirement is missing, file a holdup and do not call `occurrence_complete`.

Service-specific prompts decide how to fulfill the requirement:

- Google: `gws-as <account> ...`
- X: saved X browser profile / `x-retweet <status-url>`
- Matcherino: saved Matcherino browser profile
- browserless: headless rendering only; it is not an auth mechanism

## Local setup

Google accounts:

```bash
gws-as support@matcherino.com auth login
gws-as support@matcherino.com auth status
```

Each account has its own config dir under `~/.config/gws/accounts/<account>`. Authenticating one account does not overwrite another.

Browser credentials are managed in **This machine → Integrations**. Active browser credentials join machine capabilities, but the object’s `requires_auth` selector is what tells an agent which one it must use.
