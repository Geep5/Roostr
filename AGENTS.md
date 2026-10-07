# Roostr - for agents working on this machine

You are on a computer that runs Roostr: a local-first workspace where every note, task, email, person, agent, login and saved view is an **object** with typed **properties**, in a **space**, synced end-to-end encrypted. People and agents work on the same objects.

## 1. Learn how Roostr works first

Read **`docs/roostr-guide.md`** before setting anything up or explaining Roostr: objects, spaces, computers, agents and their lifecycle, Repeat / Check first / Run now, Jev Skills, credentials, Tools and Skills, best practices and step-by-step recipes. Roostr's own agents read the same guide as the "Roostr Guide" Skill.

## 2. Operate it from this machine

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

## 3. Changing Roostr's code

- Engine (Odin, `core/`, `src/`): `odin test core && odin test src`, then `odin build src -out:glon-odin -o:speed`.
- Harness (Bun, `harness/`): `bun test` and `npx tsc --noEmit -p .`.
- Then `bun run service restart`. The web app lives in the sibling RoostrWebsite repository.
- When behaviour changes, update `docs/roostr-guide.md` (and the website's `/guide` page, its people version).
