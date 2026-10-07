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
3. **Start Roostr as a service** (from `harness/`): `bun run service install` - add `--web <path to the RoostrWebsite repo>` to also serve the web app on `http://127.0.0.1:5190/app` (pair it with the code in `bun run service logs`). The logs should show `[sync] identity <pubkey>… relays: …` and `[sync] backfill: N event(s)`: the account's objects arriving.
4. **Check the Computer object exists:**
   ```bash
   curl -s http://127.0.0.1:7334/machine -H "Authorization: Bearer $TOK"   # {"id": <this computer's machine_id>, "host": …}
   ```
   It also shows in the app as a Computer, with **Starts automatically** ticked.
5. **The agent.** Either `bun run src/index.ts setup --name "My Agent"` (optional `--channel <space id>`, `--model <model>`), which makes one from the space's Agent template with Served by = this computer and the shell and web tools, or configure one the person made in the app. Everything is a property set with `set_field` on the agent (`{"action":"set_field","object_id":"<agent id>","key":…,"value":…}`):

   | Property | Value | Notes |
   |---|---|---|
   | `served_by` | `{"stringValue":"<machine_id>"}` | the id from step 4 as text, not a link to the Computer object. This computer adopts the agent within seconds. |
   | `model` | `{"valuesValue":{"items":[{"stringValue":"claude-opus-5-5"}]}}` | a select. Its options are fixed in the engine (`BUNDLED_RELATIONS` in `core/mutate.odin`): `claude-opus-5-5`, `claude-sonnet-4-5`, `kimi-k3`. If unset, the agent uses its System prompt's Model. |
   | `prompt` | link → `system_prompt` object | if unset, the harness links the space's "Assistant" prompt the first time it serves the agent. |
   | `credentials` | `{"valuesValue":{"items":[{"linkValue":{"targetId":"<credential id>","relationKey":"credentials"}}]}}` | needs a model key, see step 6. |
   | `tools` | links (relationKey `tools`) → the space's `tool` objects | the defaults are `shell_exec` and `web_fetch`, which an agent made from the template gets automatically. |

6. **A model key.** An agent calls its model with a **Credential** listed in its `credentials`: a `credential` object with `service` `anthropic` and the key in `key_api_key`. Make one in the app (New object → Credential → Anthropic), or through the API:
   ```bash
   curl -s -X POST http://127.0.0.1:7333/api/mutate -H "Authorization: Bearer $TOK" -d '{"action":"create","name":"Anthropic","type_key":"credential","fields":{"channel":{"stringValue":"<space id>"},"service":{"stringValue":"anthropic"},"key_api_key":{"stringValue":"sk-ant-…"},"served_by":{"stringValue":"<machine_id>"}}}'
   ```
   Only the computer named in the credential's own `served_by` marks it `active`. Without that, the agent shows `credential signed out: <name>` on its Error. A key starting `sk-ant-oat…` (from `claude setup-token`) is sent as a subscription token; any other key is sent as an API key.
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
- **Test on a throwaway object**, then delete it.

## 4. Changing Roostr's code

- Engine (Odin, `core/`, `src/`): `odin test core && odin test src`, then `odin build src -out:glon-odin -o:speed`.
- Harness (Bun, `harness/`): `bun test` and `npx tsc --noEmit -p .`.
- Then `bun run service restart`. The web app lives in the sibling RoostrWebsite repository.
- When behaviour changes, update `docs/roostr-guide.md` (and the website's `/guide` page, its people version).
