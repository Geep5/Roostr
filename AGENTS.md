# Roostr - for agents working on this machine

You are on a computer that runs Roostr: a local-first workspace where every note, task, email, person, agent, login and saved view is an **object** with typed **properties**, in a **space**, synced end-to-end encrypted. People and agents work on the same objects.

## 1. Learn how Roostr works first

Read **`docs/roostr-guide.md`** before setting anything up or explaining Roostr: objects, spaces, computers, agents and their lifecycle, Repeat / Check first / Run now, Jev Skills, credentials, Tools and Skills, best practices and step-by-step recipes. Roostr's own agents read the same guide as the "Roostr Guide" Skill.

## 2. Set up this computer (done from the terminal - no agent can run until it is)

A computer becomes part of Roostr when its harness first starts: it creates this computer's **Computer** object by itself (named after the host), with a stable `machine_id` kept in `~/.glon/harness.json`. Agents run on a computer because their **Served by** names that `machine_id`. Steps, in the Roostr repo:

1. **Build and install.** Odin `dev-2026-07` and Bun (see the README's Toolchain). Homebrew's `odin` may be newer than the pin; the pinned build is the `dev-2026-07` release on GitHub (`gh release download dev-2026-07 -R odin-lang/Odin`). `src/cosmos.odin` uses `vendor:wgpu`, which needs `libwgpu_native.a` from wgpu-native `v29.0.1.1` unpacked into Odin's `vendor/wgpu/lib/wgpu-<os>-<arch>-release/` (the compile error names the exact path). Then:
   ```bash
   odin build src -out:glon-odin -o:speed
   cd harness && bun install
   mkdir -m 700 ~/.glon        # the store does not create its data folder; it panics "cannot securely create api-token" without it
   ```
2. **Choose the identity before the service starts.** A fresh install makes a *new* key - a new, empty account - and the harness registers this Computer under whatever key the store holds when it first starts. To join the person's existing account (their spaces, agents and logins), import their key first:
   - get it on a computer that already has it: `./glon-odin key-export` (prints `nsec1…`), or the web app's Settings → Reveal private key;
   - here, with only the store running (`./glon-odin serve`, then stop it once done):
     ```bash
     TOK=$(cat ~/.glon/api-token)
     curl -s -X POST http://127.0.0.1:7333/api/mutate -H "Authorization: Bearer $TOK" -d '{"action":"nostr_key_import","key":"nsec1…"}'
     # Importing clears the relay list, and with no relays nothing syncs ("[sync] no relays configured"). Put the default back:
     curl -s -X POST http://127.0.0.1:7333/api/mutate -H "Authorization: Bearer $TOK" -d '{"action":"nostr_relays_set","relays":["wss://roostr-relay.fly.dev"]}'
     ```
   - The key *is* the account: never print it into a chat, an object or a log.
3. **Start Roostr as a service** (from `harness/`): `bun run service install` - add `--web <path to the RoostrWebsite repo>` to also serve the web app on `http://127.0.0.1:5190/app` (it builds the repo's `gpui/web-dist` first when that is missing or stale, which needs `cargo` and the `wasm32-unknown-unknown` target; the page pairs with this computer's store and shows its one-use pairing code). The logs should show `[sync] identity <pubkey>… relays: …` and `[sync] backfill: N event(s)`: the account's objects arriving.
4. **Check the Computer object exists:**
   ```bash
   curl -s http://127.0.0.1:7334/machine -H "Authorization: Bearer $TOK"   # {"id": <this computer's machine_id>, "host": …}
   ```
   It also shows in the app as a Computer, with **Starts automatically** ticked.
5. **The agent.** Either `bun run src/index.ts setup --name "My Agent"` (optional `--channel <space id>`, `--model <model>`), which makes one from the space's Agent template with Served by = this computer and the shell and web tools, or configure one the person made in the app. Everything is a property set with `set_field` on the agent (`{"action":"set_field","object_id":"<agent id>","key":…,"value":…}`):

   | Property | Value | Notes |
   |---|---|---|
   | `served_by` | `{"stringValue":"<machine_id>"}` | the id from step 4 as text, not a link to the Computer object. This computer adopts the agent within seconds. |
   | `model` | `{"valuesValue":{"items":[{"stringValue":"claude-opus-5-5"}]}}` | a select, **required**: the agent runs only on its own Model (blank = `No Model set` on its Error; nothing falls back to the System prompt). Options are fixed in the engine (`BUNDLED_RELATIONS` in `core/mutate.odin`): `claude-opus-5-5`, `claude-sonnet-4-5`, `kimi-k3`. `setup` and the app's "+ New agent" fill in `claude-sonnet-4-5`. |
   | `prompt` | link → `system_prompt` object | if unset, the harness links the space's "Assistant" prompt the first time it serves the agent. |
   | `credentials` | `{"valuesValue":{"items":[{"linkValue":{"targetId":"<credential id>","relationKey":"credentials"}}]}}` | needs a model key, see step 6. |
   | `tools` | links (relationKey `tools`) → the space's `tool` objects | the defaults are `shell_exec` and `web_fetch`, which an agent made from the template gets automatically. |

6. **A model key.** An agent calls its model with a **Credential** listed in its `credentials`: a `credential` object with `service` `anthropic` and the key in `key_api_key`. Every space you own already has one, named "Anthropic", with its key empty (Error: `No key yet - paste "API key or token"`), and new agents - `setup` and the app's "+ New agent" - list it. So the usual step is to paste the key into that credential (in the app, or `set_field` key `key_api_key` on it). An agent listing it before then shows `The "Anthropic" credential has no key…` on its Error. Each space also starts with a "<Space> Space" agent, its setup helper, served by the computer that seeded it.
   ```bash
   curl -s -X POST http://127.0.0.1:7333/api/query -H "Authorization: Bearer $TOK" -d '{"type":"credential","filters":[{"key":"service","condition":"equal","value":"anthropic"}]}'   # find the space's one
   curl -s -X POST http://127.0.0.1:7333/api/mutate -H "Authorization: Bearer $TOK" -d '{"action":"set_field","object_id":"<credential id>","key":"key_api_key","value":{"stringValue":"sk-ant-…"}}'
   ```
   Only the computer named in the credential's own `served_by` marks it `active`. A key starting `sk-ant-oat…` (from `claude setup-token`) is sent as a subscription token; any other key is sent as an API key.
7. **Confirm it answers:** `curl -s http://127.0.0.1:7334/agents -H "Authorization: Bearer $TOK"` lists it under `serving`, and its `error` property is empty. Then, on a throwaway object: set `agent` to a link to the agent (relationKey `agent`), `{"action":"chat_post","object_id":"<object id>","text":"@<Agent name> say pong"}`, and read the reply in `GET /api/objects/<object id>` (a chat block authored by the agent). Delete the object afterwards.

## 3. Operate it from this machine

Everything runs as one service, from `harness/`:

```bash
bun run service install     # once: store + sync + harness start at login/boot, crashes restart and show on the Computer's Error
bun run service restart     # after every git pull or engine rebuild - running programs keep the old code until then
bun run service logs        # every program's output (macOS file: ~/Library/Logs/Roostr/roostr.log)
```

Read and change objects through the store's HTTP API on `http://127.0.0.1:7333`, authenticated with the token in `~/.glon/api-token` (`GLON_DATA/api-token`). The README's **"For external machines"** section is the reference: query, read, create, set properties, post in a chat, watch changes, check that an agent is answering.

```bash
TOK=$(cat ~/.glon/api-token)
curl -s -X POST http://127.0.0.1:7333/api/query  -H "Authorization: Bearer $TOK" -d '{"type":"task","limit":20}'
curl -s http://127.0.0.1:7333/api/objects/<id>   -H "Authorization: Bearer $TOK"
curl -s -X POST http://127.0.0.1:7333/api/mutate -H "Authorization: Bearer $TOK" -d '{"action":"set_field","object_id":"<id>","key":"done","value":{"boolValue":true}}'
```

Rules that keep it working for the people using it:

- **Work through objects and properties**, never around them: set only properties that exist in the space (create one only when none fits - everyone sees it). What isn't on an object doesn't exist for the people using it.
- **Problems go on the object's `error` property**, never only in a log or a chat line.
- **Don't run a second store, sync or harness** next to the service; restart the service instead.
- **Agents are objects too**: change one by editing its properties (System prompt, Model, Credentials, Tools, Skills, Served by), not code.
- **Test on a throwaway object**, then delete it. Careful with `vanish`: it also deletes, for good, every agent on that object that no other object lists (`object_agent_cascade`, `core/mutate.odin`) - a brand-new agent tested only there goes with it. Use `delete` (the bin), or take the agent off the object's `agent` first.

Skills, machine software and recurring work:

- **Skills belong to a space**: an agent sees only its own space's Skills, and the defaults (Roostr Guide, catalog skills) are one copy per space you own. Make a new Skill in the space of the agents that use it. **An agent's Skills property is a whitelist** once it lists anything: a new skill stays invisible to that agent until it is added there. A skill only one agent should see (its private playbook) carries that agent's id in its `agent` field.
- **Machine software (a catalog skill with a `key`, like `browserless`) is installed per computer, by a person.** The first time, that computer has no Capability object for it, so there is no Install button: create one (`type_key` `capability`, fields `key`, `served_by` = the machine_id, `status` `missing`), then in the web app paired with that computer open it → Status → **Install** → **Approve**. An installer agent writes the software from the catalog spec; `active` only means the check command passed, so run the command yourself before relying on it.
- **Recurring work is a Repeat on the object, never a property.** From the API: `{"action":"repeat_set","object_id":"<id>","rule":{"freq":"minute","interval":10,"weekdays":[],"monthly":"date","tz":"<IANA zone>","window":[0,1439]},"now_ms":<now>,"tz_offset_min":<offset>}` (agents use `object_set_repeat`). Run now = `set_field` `run_now` to `{"mapValue":{"entries":{"at":{"intValue":<now>}}}}`. The run's steps are the object's page; the agent's reply lands in its own transcript, problems on the object's `error`.
- **An agent that @-mentions another agent is woken again by the answer** (`answersGuestQuestion`, `harness/src/index.ts`): the reply lands as a new turn for the asker. So never let the agent that asks also hold a risky power (sending, paying, deleting): split it into its own agent that only a person's message wakes, and never mentions anyone.
- **Agents reuse what worked last run.** After changing a skill's commands, the running agents keep using the old ones unless their instructions say to `skill_read` the skill at the start of every run - put that on the repeating object's page.

## 4. Changing Roostr's code

- Engine (Odin, `core/`, `src/`): `odin test core && odin test src`, then `odin build src -out:glon-odin -o:speed`.
- Harness (Bun, `harness/`): `bun test` and `npx tsc --noEmit -p .`.
- Then `bun run service restart`. The web app lives in the sibling RoostrWebsite repository (Rust/GPUI, `gpui/`); with `--web` the restart rebuilds it when its sources changed.
- When behaviour changes, update `docs/roostr-guide.md` (and the website's `/guide` page, its people version).
- Commit only what helps any Roostr deployment. Anything naming one account, person, login or site's workflow lives in the account as objects (skills, prompts, tasks), or, when it must be a file, in the gitignored `harness/private/<name>/` extension (README, "What only one deployment needs").
