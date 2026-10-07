# Roostr - for agents working on this machine

You are on a computer that runs Roostr: a local-first workspace where every note, task, email, person, agent, login and saved view is an **object** with typed **properties**, in a **space**, synced end-to-end encrypted. People and agents work on the same objects.

## 1. Learn how Roostr works first

Read **`docs/roostr-guide.md`** before setting anything up or explaining Roostr: objects, spaces, computers, agents and their lifecycle, Repeat / Check first / Run now, Jev Skills, credentials, Tools and Skills, best practices and step-by-step recipes. Roostr's own agents read the same guide as the "Roostr Guide" Skill.

## 2. Set up this computer (done from the terminal - no agent can run until it is)

A computer becomes part of Roostr when its harness first starts: it creates this computer's **Computer** object by itself (named after the host), with a stable `machine_id` kept in `~/.glon/harness.json`. Agents run on a computer because their **Served by** names that `machine_id`. Steps, in the Roostr repo:

1. **Build and install.** Odin `dev-2026-07` and Bun (see the README's Toolchain), then:
   ```bash
   odin build src -out:glon-odin -o:speed
   cd harness && bun install
   ```
2. **Choose the identity before anything else.** A fresh install makes a *new* key - a new, empty account. To join the person's existing account (their spaces, agents and logins), import their key:
   - on a computer that already has it: `./glon-odin key-export` (prints `nsec1…`), or the web app's Settings → Reveal private key;
   - here, once the store runs (step 3): `curl -s -X POST http://127.0.0.1:7333/api/mutate -H "Authorization: Bearer $(cat ~/.glon/api-token)" -d '{"action":"nostr_key_import","key":"nsec1…"}'` (or pair the web app and use Sign in with a Nostr key), then `bun run service restart` so sync and the harness use it. Sync then pulls the account's objects from the relays.
   - The key *is* the account: never print it into a chat, an object or a log.
3. **Start Roostr as a service** (from `harness/`): `bun run service install` - add `--web <path to the RoostrWebsite repo>` to also serve the web app on `http://127.0.0.1:5190/app` (pair it with the code in `bun run service logs`).
4. **Check the Computer object exists:**
   ```bash
   curl -s http://127.0.0.1:7334/machine -H "Authorization: Bearer $(cat ~/.glon/api-token)"   # {"id": <this computer's machine_id>, "host": …}
   ```
   It also shows in the app as a Computer, with **Starts automatically** ticked.
5. **A model key.** Agents call their model with a **Credential** in their Credentials - for Claude, an Anthropic credential holding an API key (`sk-ant-api…`) or a `claude setup-token` token. Make one in the app (New object → Credential → Anthropic), or reuse the account's existing one.
6. **The first agent:**
   ```bash
   bun run src/index.ts setup --name "My Agent"     # optional: --channel <space id>, --model <model>
   ```
   It is made from the space's Agent template with **Served by = this computer** and the shell and web tools; this computer adopts it within seconds. Add the Anthropic credential to its **Credentials** (in the app, or `set_field` key `credentials` with a list of links). Its System prompt, Model, Skills and Tools are properties - change them the same way.
7. **Confirm it answers:** `curl -s http://127.0.0.1:7334/agents -H "Authorization: Bearer $(cat ~/.glon/api-token)"` lists it under `serving`; then put it in an object's Agent property and @-mention it in that object's chat.

To move an existing agent to this computer instead, set its **Served by** to this computer's `machine_id` (the string from step 4 - not a link to the Computer object).

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
