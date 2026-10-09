# Roostr Guide

How Roostr works, for agents that set things up in it or explain it to people. Read the section you need; the recipes and best practices at the end are the shortest path to a good setup.

## 1. The idea in one paragraph

Everything in Roostr is an object: a note, a task, an email, a person, an agent, a computer, a login, a saved view. An object's page (its body) holds the content; its Properties hold the settings and facts about it. People and agents work on the same objects and see the same thing. When something goes wrong, it shows on the object itself as its Error property - never silently.

## 2. Objects

- **Type**: what kind of object it is (Note, Task, Page, Email, Human, Agent, Skill...). A space can have its own types. A type's layout decides the page: a task-layout type has a Done checkbox.
- **Body**: lines of text, each a block: paragraph, heading, bullet, numbered item, checkbox, quote, code, toggle, link card, file. Blocks nest.
- **Properties**: named fields defined once per space (a "relation": key, name, format) and set per object. Formats: text, number, date, checkbox, status (one option), tag (many options), object (links to other objects), url, email, phone, file. Set only properties that exist; create a new one only when none fits, because everyone in the space sees it.
- **Links**: an object-format property (Agent, Credentials, a "Project" field) or a link card in the body. Prefer a property when the link is a fact you will filter or sort by.
- **Templates**: a template stamps out new objects of a type with properties (and a body) already filled in. A type's default template is used for "+ New". Agents themselves are usually made from an Agent template.
- **Saved views**: a **Query** is a live filter (type plus conditions, e.g. "Emails where Done is unchecked"); a **Collection** is a hand-picked list. Both are objects people use as their map of the space - read them before guessing.
- **Bin**: deleting moves an object to its space's bin; it can be restored with its text, properties and history.
- **History**: every change is kept. Nothing is overwritten in place.

## 3. Spaces

- A **space** is a shared area: its objects, types, properties, templates, agents and Tools. Each object belongs to one space (its `channel`). A few personal objects belong to no space and are private to one person.
- A space is **private** (only you) or **shared** (its members). Everything in it is end-to-end encrypted to the space's key and synced over relays; only members can read it. Files go peer to peer.
- Members see the same objects. An agent in one space cannot see or act on another space's objects, and agent pickers offer only the space's own agents. When something "is missing", check which space you are in first.
- Deleting a space deletes everything in it, for every member.

## 4. Computers

- A **computer** (a Computer object) is a machine running Roostr: the store (`glon-odin serve`), sync, and the harness - the part that runs agents and repeats. Its harness creates its Computer object the first time it starts; agents run there because their Served by names its `machine_id`. Setting a computer up (build, identity, the service, a model key, the first agent) is done from its terminal - the steps are in the Roostr repo's `AGENTS.md`, "Set up this computer". Join the person's existing account by importing their key first; a fresh install is otherwise a new, empty account.
- **Run it as a service.** In the Roostr repo's `harness/` folder: `bun run service install` (add `--web <path to the website repo>` to also run the local web app). It starts everything at login (macOS) or boot (Linux), restarts a program that crashes, and writes a crash - which program, how it ended, its last output - as the Computer object's Error. The Computer's **Starts automatically** box is ticked while the service runs it.
- **After pulling new code or rebuilding the engine: `bun run service restart`** (in `harness/`) - the running programs keep the old code until then. `bun run service logs` follows every program's output (macOS log file: `~/Library/Logs/Roostr/roostr.log`); `bun run service uninstall` stops and removes it. Never start a second store, sync or harness by hand next to the service - the harness and sync refuse a second copy on one computer.
- Without a computer, Roostr still stores and syncs objects, but nothing acts: no agent answers, nothing repeats. An agent whose computer is off simply doesn't answer - check that computer first when an agent goes quiet.
- A computer can have **capabilities**: installed software from the catalog (for example headless Chrome for `web_fetch`, Google Workspace for Gmail). Each capability object says whether it works on that computer (active, needs_auth, missing, broken...). A Skill with a `key` needs that capability on the agent's computer.

## 5. Agents

### What an agent is made of

An agent is an object whose properties are its configuration - nothing is hidden in code:

- **System prompt**: links a System prompt object - the agent's standing instructions (its page) and default model.
- **Model**: which model runs it (e.g. a Claude model). Overrides the prompt's model.
- **Credentials**: logins it uses - its model key (an Anthropic or Kimi credential) and service logins (Gmail, Discord, a database...).
- **Tools**: extra tools beyond the always-on core - gated built-ins (`shell_exec`, `web_fetch`) and custom Tool objects.
- **Skills**: instructions it may read (like this guide). With none listed it sees every Skill; with a list, only those.
- **Served by**: the one computer it runs on. No Served by, no runs - its Error property says so.
- **Project folder**: optional - the folder on that computer where it works (repo work with the shell).

The always-on core tools let every agent read and edit objects (`object_get`, `object_set_field`, `object_add_text`, `object_create`, `object_delete`, `find`, `query_run`, `space_map`, `neighborhood`...), read Skills, keep memory, schedule (`object_set_repeat`, `occurrence_complete`), ask other agents (`agent_ask`) and delegate (`spawn`).

### Lifecycle

1. **Made**: from the space's Agent template ("+ New agent" in a picker - named right there - or New object -> Agent). The template supplies the prompt, model, tools and credentials. Made from an object's Agent row, it also starts with that object's tags (an agent made on a Team task is Customer: Team); made from a cell or the new-row line of a query's table, it starts with the query's filter values.
2. **Placed**: its Served by names a computer. That computer's harness adopts it within seconds - no restart. Change Served by and it moves; the old computer lets go.
3. **Invited**: an object's **Agent** property is its guest list. An agent only ever works on objects that list it (and on its own page). Nothing answers an object uninvited.
4. **Woken**: a person (or another agent) @-mentions it in the object's chat, or a Repeat on an object it is on fires. A chat post with no @ wakes nobody.
5. **Turn**: the harness builds its prompt (system prompt, the workspace rules, Skills listing, memory, the object), the model calls tools, the harness runs them, until it has an answer.
6. **Posts**: only its final text is posted to the chat. Text written alongside tool calls is kept as working notes on those calls, not posted.
7. **Remembers**: each agent keeps one transcript (compacted over time), plus pinned facts and milestones it writes with its memory tools.
8. **Ends**: deleting the agent, or clearing Served by, stops it everywhere. Its past messages stay.

### Talking between agents

- On an object where two agents are both guests, an agent asks the other by starting its reply with "@Their Name" and the question.
- To ask an agent on a different object, use `agent_ask` (the target object must list that agent). Agent-to-agent back-and-forth is capped at a few hops.
- `spawn` hands a self-contained task to a short-lived helper that returns one result.

## 6. Repeat and Check first

- **Repeat** (on any object): every N minutes, hours, days, weeks, months or years, with times and days. Each occurrence fires once, on the computer serving the object (its own Served by, else the first agent on it that has one).
- **What fires**: the object's first served agent gets a message with the object's page as instructions and one turn. With no agent, the object's chat gets a reminder and its Error property says it has no agent.
- **Finishing**: a day-or-longer repeat waits until its run is marked done (`occurrence_complete`, or a person ticking Done). Minute and hour repeats complete themselves after each run. Call `occurrence_complete` only when the object's instructions say the run is done - and say plainly what blocks it otherwise.
- **Check first**: links a Tool that runs before each occurrence, without a model. An empty result (nothing, `[]`, `{}`) ends the run there - no turn, no cost. A non-empty result is put in front of the agent's instructions. Use it for "only wake the agent when there is something new".
- **One run at a time**: while any run of an object is in progress (shown as "Running now on <computer>" under Repeat, on every device), another Run now is refused and an occurrence that comes due waits, firing when the run ends.
- **Run now** (in the Repeat editor, from any device): the computer that serves the object starts a run right away. While an occurrence is **open** - it fired and never finished - the button is **Retry run**: it reruns that occurrence, and finishing it moves the schedule on. Otherwise it is an extra run outside the schedule (it must not call `occurrence_complete`). **Skip this run** finishes an open occurrence without doing it, as ticking Done does.
- **Stuck runs**: an occurrence still open when the next one would be due shows on the object's Error - "run never finished: the <when> run is still open… It is waiting for a reply from <agent> (runs on <computer>)" or the last chat message - and under Repeat as "Stuck since …". The schedule waits for a person: fix the cause, then Retry run or Skip this run. The Error clears once the run finishes.
- **Runs**: each run is recorded on the object. A failing run sets its Error property, and so does a signed-out login any turn on the object hits; the next clean run clears it.

## 7. Jev Skills (typed scores by Jev)

- A **Jev Skill** is a Skill with an **Answer** (Score, Choice or Yes or no). It is one question TypeSafe's Jev answers about objects - in about a second, cheaply, with how sure it is - and the answer is written as a property: its **Writes to**, else the Skill's name ("Spam meter" writes "Spam meter").
- **Its page is the question**: paragraphs are the instructions; a numbered list is a Score's levels (2 to 10, lowest first); a bulleted list is a Choice's options (`Name: what it means`); `Yes: ...` / `No: ...` lines describe a Yes/No.
- **Using it**: an agent with the Skill in its Skills runs it with `jev_score(skill, object_ids)` - many objects in one call - paying with the TypeSafe credential in its own Credentials. It gets back each object's value, the answer in words and how sure, and can act on them in the same turn. Code Tools call `roostr.jev(skill, ids)`.
- **When**: whenever the agent's instructions say so, or automatically on arrival: an object with a Check first lists Jev Skills in its **Score with**, and everything the check brings in is scored with them before its agent's turn (paid with that agent's TypeSafe credential). Otherwise nothing re-scores on its own: a person can click the value's "Ask again".
- Scores are ordinary properties: filter, sort and build queries on them ("Emails where Spam meter >= 8"). Next to the value: how sure Jev was ("9 · 97% sure") and which Skill and agent set it.
- **Acting on scores**: a saved Query does it - its filters are the condition ("Emails where Spam meter >= 8") and its action properties the action (see Queries that act).

### Queries that act

- A Query with **Move to bin**, **Mark done**, **Tag agents** (agents added to the object and @-mentioned in its chat, which wakes them) or **Set property** + **Set value** does that to everything it matches - including what already matched when you switched it on. Open the query to see exactly what it acts on.
- Each object is acted on once per query: it keeps which queries acted on it, so restoring it from the bin (or unticking Done) overrules that query for it for good. Every action leaves one line in the object's chat ("binned by \"Spam to bin\"").
- It runs on the query's computer: its Served by, else its Agent's. A query nobody runs, or an action that fails, shows on the query's Error. It acts within seconds of a change, and inbox imports run it before the agent's turn, so what it bins is never shown to the agent.

## 8. Credentials

- A **Credential** object is one login: an API key, a bot token, a database URL, a browser sign-in, a Google account. Its **Served by** is the computer that keeps and checks it; its Status says whether it works (Connected, Signed out - reconnect, Broken...).
- Keys pasted into a credential are readable by members of its space. Browser sign-ins are kept on its computer.
- A Credential's browser sign-in is done by a person: **Connect** opens the sign-in window on the credential's computer. An agent can create the credential and ask a person to press Connect; it cannot do that sign-in itself.
- An agent can sign in to a site on its own with Headless Chrome: `browserless --profile <name> --eval '<js>' <url>` runs JavaScript in the page with a Chrome profile kept on its computer, so it fills the login form once and later runs stay signed in (the Headless Chrome skill says how). The login it types comes from its own instructions - a system prompt or a skill only it can read.
- An agent uses a credential only if its Credentials property lists it. Having the credential is the permission; what to do with it is in the agent's instructions.

## 9. Tools and Skills

- **Tools** are objects: a name the model calls, a description, inputs, and TypeScript in the body, run by the harness. Built-in Tools ship with Roostr in every space; custom Tools are written the same way and given to agents through their Tools property.
- **Skills** are instructions an agent reads on demand. Every agent's prompt lists Skills by name and one line; the agent reads the full page with `skill_read` when the task matches. A Skill with a `key` is also catalog software its computer must have.

## 10. How an agent should behave in Roostr

These are enforced by the harness for every agent; follow them in any prompt you write:

- Say something is done only when a tool's reply shows it done, and describe it the way the reply does.
- A reply starting "error:" means nothing changed: fix it or say what didn't happen.
- Never fake a feature with a made-up field, a line of text or an emoji. If no tool does it, say so.
- In chat, post only what someone needs: the answer, the result, a question, or a blocker. One message per turn. No narration ("let me check..."), no "waiting for...", no recap of what you just did.
- Report problems on the object (`object_flag_error`) so they show in people's views.

## 11. Best practices

### Designing a setup

- **One job per agent.** A triage agent, a support agent, a writer - not one agent that does everything. Small prompts are more reliable and cheaper.
- **Instructions live on the work.** Put a recurring job's steps on the repeating object's page, not in the agent's system prompt. The prompt says who the agent is; the object says what to do this time.
- **Make the work visible as objects.** Imported email, tickets, leads: one object each, with properties (status, owner, scores). People can then see, sort, query and fix them.
- **Use properties for anything you will filter on.** Status, Done, scores, owner. Text in the body is for reading, properties are for deciding.
- **Use templates for anything made more than twice.** A template keeps every new one consistent (properties, agents, body).
- **Give people a saved view of the result.** Every automated pipeline should end in a Query someone can open ("Support Emails not done").

### Keeping it cheap and calm

- **Check first before waking an agent.** A Tool that returns `[]` when there is nothing new costs nothing; a model turn every 5 minutes does.
- **Score with Jev, decide with the agent.** A Jev Skill (fast, cheap, typed) scores or classifies many objects at once; the agent acts on the scores instead of reading and judging each one itself.
- **Pick the slowest Repeat that is fast enough.** Hourly is usually plenty; minute repeats are for genuinely live work.
- **Minimal Tools.** Give `shell_exec` only to agents that need a computer; give credentials only to agents that use them.

### Reliability

- **Every agent needs Served by, a running computer and a model key.** Check all three first when "it doesn't answer" - an agent asking another agent waits as long as that agent's computer is off.
- **Read the Error property** - on the object, its agent and its Computer. Failed runs, stuck runs, missing computers, crashed programs, signed-out credentials and broken Tools all show there - fix the cause, and the next clean run (or Retry run) clears it.
- **Keep computers on the service** (`bun run service install`), and run `bun run service restart` after every pull or rebuild.
- **Test on a throwaway object** before pointing a setup at real data, then delete it.
- **Don't duplicate.** Search (`find`, `space_map`, saved views) before creating types, properties, templates or agents that may already exist.
- **Name things for people.** Clear names on agents, properties and views; the name is the interface.

## 12. Recipes

### A recurring task run by an agent

1. Create a Task; write the steps on its page (what to do, what to post, when it is done).
2. Add the agent to its Agent property.
3. Set its Repeat (e.g. every weekday at 9:00).
4. Optional: Check first with a Tool that returns `[]` when there is nothing to do.
5. Check the run record and Error after the first occurrence.

### An inbox that imports and triages

1. A Google account credential for the mailbox, connected on the computer that will run it.
2. A Task "Check support inbox" with Repeat every 5-15 minutes and Check first = an import Tool (one that reads the mailbox, creates one Email object per thread and returns the new ones, `[]` when none). Its settings (mailbox, agents to add to each email) are properties on the task.
3. Agent: a triage agent on the task, with Jev Skills such as Spam meter in its Skills and a TypeSafe credential. The task's page says how to triage: first score the new emails, then close spam and tag the support agent on real questions.
4. A Query "Support Emails not done" for people.

### Score objects with a Jev Skill

1. Make a TypeSafe credential with the API key and add it to the agent's Credentials.
2. New object -> Skill. Name it after the property (e.g. "Urgency"); set Answer = Score (Writes to, if the property should have another name); a one-line description says what it scores.
3. Write the question and a numbered list of levels on its page.
4. Add the Skill to the agent's Skills, and say on its task's page when to run it.
5. Build a Query on the new property.

### Give an agent a login

1. New object -> Credential from the service's template; set Served by to the computer that should keep it.
2. Paste the key, or ask a person to press Connect.
3. Add the credential to the agent's Credentials.
4. Say in the agent's instructions which actions to use and when.

### Add a new agent

1. "+ New agent" in any agent picker (name it right there) or New object -> Agent.
2. Set Served by; check its System prompt, Model and Credentials (a model key).
3. Add it to the objects it should work on.
4. @-mention it once to confirm it answers.

### Keep a computer running Roostr

1. In the Roostr repo: build the engine (`odin build src -out:glon-odin -o:speed`), then `cd harness && bun install`.
2. `bun run service install` (`--web <path to the website repo>` to serve the local web app too). Its Computer object now shows Starts automatically.
3. After every `git pull` or rebuild: `bun run service restart`.
4. Something wrong: `bun run service logs`, and the Computer object's Error.
