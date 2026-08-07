# Herdr Relay Bridge

Make a [Herdr](https://herdr.dev) session a participating member of an
[Agent Relay](https://github.com/agent-relay) workspace. Agent status changes are
forwarded into a Relay channel, and other agents in that workspace can query your
fleet's live state through a typed `herdr.session_summary` action.

The same plugin can also turn a project-scoped local Relay broker into a Herdr
workspace: the fleet picker opens one attached pane per live broker agent and
projects the broker's authoritative state onto each pane.

This is a connector, not a notifier. If you want a push notification on your
phone when an agent blocks, several plugins do that well — see
[Related plugins](#related-plugins). Use this one when the thing that should
learn an agent is blocked is **another agent**, not a person.

## Why

Coding agents running in Herdr panes are invisible to everything outside the
terminal. Agent Relay is where an agent fleet already coordinates. This bridge
joins the two: statuses land in a Relay channel alongside your other agents, and
the Herdr side becomes queryable — a supervising agent can ask how many panes are
blocked before deciding what to dispatch next.

Multiple machines fan into one channel. Each bridge derives a stable identity
from its hostname and Herdr socket path, so a laptop and a build box show up as
distinct members of the same workspace.

## What it does, and what it will not do

The `bridge` entrypoint forwards:

- `pane.agent_status_changed` for workspaces you explicitly allowlist
- aggregate status counts, on request, via `herdr.session_summary`

The optional `fleet` entrypoint:

- reads `agent-relay node agent list` from the active Herdr project's cwd
- creates a `Relay fleet` workspace with one attached pane per live broker agent
- reports broker `current_state` through Herdr's `pane.report_agent` API

Never touched by the bridge entrypoint:

- pane output, scrollback, working directory, environment, or terminal titles
- prompts, keystrokes, shell commands, or raw socket control

The bridge entrypoint has no write path into your panes. The fleet entrypoint is
an explicit control surface: invoking it creates a workspace, launches local
attach commands, and reports agent metadata, but it does not read scrollback or
send prompts or keystrokes.

## Requirements

- Herdr 0.7.5 or newer
- Node 22 or newer
- `agent-relay` with a running project-scoped local broker for the fleet picker

No Agent Relay account, API key, or signup is needed to start — setup creates a
free workspace for you.

## Install

```sh
herdr plugin install AgentWorkforce/herdr-relay-bridge
herdr plugin pane open --plugin agent-relay.herdr-bridge --entrypoint setup
```

Setup creates a Relay workspace, registers this machine's bridge agent, creates
the `#agent-status` channel, and writes a 0600 config with every current Herdr
workspace in the allowlist:

```text
Setting up the Agent Relay bridge for your-host.local...
  workspace created
  bridge agent registered as herdr-your-host-baa1a992dc34
  channel #agent-status created
  config written (0600)
  bridge token saved

Forwarding 2 workspace(s): w1 (api), w2 (web)
```

Then start it:

```sh
herdr plugin pane open --plugin agent-relay.herdr-bridge --entrypoint bridge
```

Setup never overwrites an existing config — rerunning it is safe and reports
what is already there. Narrow the allowlist by editing the file before starting
the bridge.

## Configure by hand

If you already have a workspace key, skip setup. Find the config directory:

```sh
herdr plugin config-dir agent-relay.herdr-bridge
```

Copy `config.example.json` there as `agent-relay.json`:

```json
{
  "workspaceKey": "rk_live_replace_me",
  "channel": "#agent-status",
  "workspaceIds": ["w1"]
}
```

`workspaceIds` is an allowlist — only those Herdr workspaces are forwarded, and
it has no default. `baseUrl` is optional; omit it to use the SDK's default
gateway. If you set it, it must be HTTPS unless it is a loopback address. The
bridge refuses to start if the file is readable by group or other, so lock it
down:

```sh
chmod 600 "$(herdr plugin config-dir agent-relay.herdr-bridge)/agent-relay.json"
```

## Run

```sh
herdr plugin pane open --plugin agent-relay.herdr-bridge --entrypoint bridge
```

The bridge runs only while that pane is open — there is no startup hook. Closing
the pane stops it and drains any in-flight deliveries first.

## Open the local broker fleet

Focus the Chief project workspace in Herdr, then run one command:

```sh
herdr plugin pane open --plugin agent-relay.herdr-bridge --entrypoint fleet
```

The picker takes the project directory from the active Herdr workspace context,
runs `agent-relay node agent list` there, and creates a new `Relay fleet`
workspace. Every live broker agent gets its own tab, launched with that same cwd
and attached in `drive` mode. To target a different project or attach read-only:

```sh
herdr plugin pane open --plugin agent-relay.herdr-bridge --entrypoint fleet \
  --env HERDR_RELAY_PROJECT_DIR=/absolute/path/to/chief \
  --env HERDR_RELAY_ATTACH_MODE=view
```

The resident chief-of-staff is launched through `scripts/chief.sh brain`, so the
documented Chief bootstrap starts the broker and agent when needed. Other panes
run `agent-relay node agent attach <name> --mode <mode>` directly.

Each pane polls the broker every five seconds and reports only changed states.
`idle` and `working` map directly, `blocked_on_send` maps to `blocked`, and every
other value (including `done`) maps to `unknown`; Herdr's pane state enum has no
`done`. If the broker cannot be reached, the picker prints a short recovery
message naming the project and the commands that can start it instead of
surfacing the raw connection-file error. The failed picker pane stays open until
you press Enter, so the recovery message does not disappear with the process.

## Querying from Relay

Any agent in the workspace can call:

```
herdr.session_summary
```

It takes no input and returns validated output:

```json
{
  "workspaceIds": ["w1"],
  "agents": 4,
  "statuses": { "idle": 1, "working": 2, "blocked": 1, "done": 0, "unknown": 0 }
}
```

Counts cover only allowlisted workspaces. The action is read-only.

## Delivery behaviour

Status forwarding is deduplicated per pane: an unchanged status is not re-sent,
and every message carries a stable idempotency key, so a retried delivery does
not double-post. If a send fails the transition is rolled back rather than
recorded, so the next matching status is forwarded instead of silently dropped.

Herdr replays retained lifecycle events from sequence zero on a fresh
subscription. The bridge discovers pane membership from periodic session
snapshots instead, so restarting it does not flood the channel with history. It
resubscribes automatically when the pane set changes or the connection drops.

## State and safety

The Relay agent token and dedupe state live only in `HERDR_PLUGIN_STATE_DIR`,
written 0600 on POSIX (on Windows they inherit the account-scoped ACL of Herdr's
plugin state directory). Restarts reconnect with the stored token rather than
registering a second Relay agent.

An exclusive lock prevents two bridge panes from racing to rotate that token. A
later start reclaims the lock only when its owner PID is gone; a live or
unidentifiable owner fails closed.

Herdr plugins run as your OS user and are not sandboxed. Review the manifest and
`dist/` before installing.

## Related plugins

Different jobs, worth knowing about:

- **Notify a human** — `herdr-hail` (Slack/Discord), `herdr-ntfy`,
  `herdr-focus-notify` (macOS), and several Telegram bridges
- **Drive Herdr from a phone** — `collie`, `herdr-remote`, `herdr-mobile-relay`
- **Ship telemetry to your own endpoint** — `herdr-telemetry`
- **Agent-to-agent messaging on one machine** — `herdr-agent-messenger`

## Development

```sh
npm ci --omit=dev
npm test
```

Tests run on Linux, macOS, and Windows in CI. They stub the Agent Relay SDK, so
they cover bridge logic rather than live gateway behaviour.

## License

Apache-2.0
