# Running the harness under launchd

Two user agents, both `KeepAlive`: the Odin daemon (`glon-odin serve`, the
store and API) and the Bun harness (`bun run serve`, agents and the
occurrence scheduler). The harness is a pure client of the daemon, so the
daemon must be running too; launchd restarts either one if it exits, and
the harness reconnects to the daemon's SSE on its own.

## Install

Build the daemon once (`odin build src -o:speed -out:glon-odin` in the
repository root) and `bun install` in `harness/`. Then, from `harness/`:

```bash
mkdir -p ~/Library/Logs/Roostr ~/Library/LaunchAgents
# Edit both plists first: replace /Users/you/projekt/4/glonOdin with your
# checkout and /Users/you with your home (launchd does not expand ~). If
# `which bun` is not /opt/homebrew/bin/bun, put its path in the harness plist.
cp launchd/app.roostr.daemon.plist launchd/app.roostr.harness.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.roostr.daemon.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.roostr.harness.plist
```

Logs land in `~/Library/Logs/Roostr/{daemon,harness}[.err].log`.

Both plists set `PATH` to include `/opt/homebrew/bin` (bun, and anything
`shell_exec` reaches for). If you run against a data root other than
`~/.glon`, uncomment `GLON_DATA` in both and give them the same value.

## Operate

```bash
launchctl kickstart -k gui/$(id -u)/app.roostr.harness   # restart now (after a code change)
launchctl kickstart -k gui/$(id -u)/app.roostr.daemon
launchctl print gui/$(id -u)/app.roostr.harness          # state, pid, last exit
launchctl bootout gui/$(id -u)/app.roostr.harness        # stop and unload
launchctl bootout gui/$(id -u)/app.roostr.daemon
```

`bootout` stops the process and forgets the job until the next
`bootstrap`; `kickstart -k` kills and relaunches it in place.

## Sleep and missed occurrences

launchd does not wake a sleeping Mac, and a closed lid stops the clock
with everything else. That is fine: the scheduler keeps no state beyond
its timer. On wake (and on every start) it re-reads the recurring objects
of the spaces this machine serves, fires every occurrence whose `next` is
already past, and arms for the earliest one still ahead. Each occurrence
fires once: `occurrence_fire` stamps `fired_for` on the object, and the
engine refuses a second fire for the same occurrence, so a restart, a
double timer, or a second machine cannot run the same task twice.
