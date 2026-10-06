# Roostr Guide

How Roostr works, for agents that set things up in it or explain it to people. Read the section you need; the recipes and best practices at the end are the shortest path to a good setup.

## 1. The idea in one paragraph

Everything in Roostr is an object: a note, a task, an email, a person, an agent, a computer, a login, a saved view. An object's page (its body) holds the content; its Properties hold the settings and facts about it. People and agents work on the same objects and see the same thing. When something goes wrong, it shows on the object itself as its Error property - never silently.

## 2. Objects

- **Type**: what kind of object it is (Note, Task, Page, Email, Human, Agent, Judge...). A space can have its own types. A type's layout decides the page: a task-layout type has a Done checkbox.
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

- A **computer** (a Computer object) is a machine running Roostr: the engine (`glon-odin serve`) and the harness (`bun run serve` in `harness/`). The harness is what runs agents, repeats and Judges.
- Without a computer, Roostr still stores and syncs objects, but nothing acts: no agent answers, nothing repeats.
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

1. **Made**: from the space's Agent template ("+ New agent" in a picker, or New object -> Agent). The template supplies the prompt, model, tools and credentials.
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
- **Finishing**: a day-or-longer repeat waits until its run is marked done (`occurrence_complete`, or a person ticking Done). Minute and hour repeats complete themselves after each run.
- **Check first**: links a Tool that runs before each occurrence, without a model. An empty result (nothing, `[]`, `{}`) ends the run there - no turn, no cost. A non-empty result is put in front of the agent's instructions. Use it for "only wake the agent when there is something new".
- **Runs**: each run is recorded on the object. A failing run sets its Error property; the next clean run clears it.

## 7. Judges (typed scores by Jev)

- A **Judge** is an object that asks TypeSafe's Jev one question about other objects and writes the answer as a property. Its name is that property ("Spam meter" writes "Spam meter").
- **Its page is the question**: paragraphs are the instructions; a numbered list is a Score's levels (2 to 10, lowest first); a bulleted list is a Choice's options (`Name: what it means`); `Yes: ...` / `No: ...` lines describe a Yes/No.
- **Its properties**: Answer (Score, Choice or Yes or no) and Credentials (a TypeSafe credential with an API key). It runs on the computer keeping that credential unless its Served by says otherwise.
- **Using it**: add the Judge to an object's **Judges** property. The object is scored within seconds and again whenever its content changes. The value shows how sure Jev was ("9 · 97% sure"); "Ask again" re-scores.
- Scores are ordinary properties: filter, sort and build queries on them ("Emails where Spam meter >= 8").
- An importer Tool can put Judges on everything it creates (for example an email import with an "Add judges" setting), so items arrive already scored, before the agent's turn.

## 8. Credentials

- A **Credential** object is one login: an API key, a bot token, a database URL, a browser sign-in, a Google account. Its **Served by** is the computer that keeps and checks it; its Status says whether it works (Connected, Signed out - reconnect, Broken...).
- Keys pasted into a credential are readable by members of its space. Browser sign-ins are kept on its computer.
- Only a person can sign in: **Connect** opens the sign-in window on the credential's computer. An agent can create the credential and ask a person to press Connect; it cannot do the sign-in itself.
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
- **Use templates for anything made more than twice.** A template keeps every new one consistent (properties, Judges, agents, body).
- **Give people a saved view of the result.** Every automated pipeline should end in a Query someone can open ("Support Emails not done").

### Keeping it cheap and calm

- **Check first before waking an agent.** A Tool that returns `[]` when there is nothing new costs nothing; a model turn every 5 minutes does.
- **Judges before agents.** Use a Judge (fast, cheap, typed) to score or classify; let the agent act on the score instead of re-reading everything.
- **Pick the slowest Repeat that is fast enough.** Hourly is usually plenty; minute repeats are for genuinely live work.
- **Minimal Tools.** Give `shell_exec` only to agents that need a computer; give credentials only to agents that use them.

### Reliability

- **Every agent needs Served by and a model key.** Check both first when "it doesn't answer".
- **Read the Error property.** Failed runs, missing computers, signed-out credentials and broken Tools all show there - fix the cause, the next clean run clears it.
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
2. A Task "Check support inbox" with Repeat every 5-15 minutes and Check first = an import Tool (one that reads the mailbox, creates one Email object per thread and returns the new ones, `[]` when none). Its settings (mailbox, agents and Judges to add to each email) are properties on the task.
3. Agent: a triage agent on the task; the task's page says how to triage (close spam, tag the support agent).
4. A Query "Support Emails not done" for people.

### Score objects with a Judge

1. Make a TypeSafe credential with the API key.
2. New object -> Judge. Name it after the property (e.g. "Urgency"); Answer = Score; Credentials = the TypeSafe credential.
3. Write the question and a numbered list of levels on its page.
4. Add the Judge to objects' Judges (or to an importer's Add judges, or a template).
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
