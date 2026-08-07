# Herdr as a fleet node

The fleet picker (T3) projects agents the broker already runs into Herdr panes.
This entrypoint closes the loop in the other direction: a placement issued
anywhere in the workspace can *create* an agent, and it appears as a visible
Herdr pane on this host.

```sh
herdr plugin pane open --plugin agent-relay.herdr-bridge --entrypoint fleet-node
```

While that pane is open, the host answers `spawn:claude` and `spawn:codex`
placements by opening a Herdr pane. Close the pane and the host stops answering.

## How dispatch flows both ways

- **Out:** `agent-relay node agent list` → picker → one pane per live agent.
- **In:** `placement.spawn` → this node → `plugin.pane.open` → the pane runs
  `agent-relay node agent new <cli>`, which creates the agent on the broker and
  attaches to it in that same pane.

Because the pane runs `node agent new`, the agent it creates is an ordinary
broker agent. It shows up in `agent-relay node agent list` like any other, and
the broker — not this plugin — remains the authority for whether it exists and
what state it is in. The pane reports state through the same
`createStatusProjector` / `pane.report_agent` path the picker uses, so a pane has
exactly one writer for its agent state.

### The acknowledgement waits for the broker

Opening a pane only *starts* `node agent new` inside it. Creation can still fail
afterwards — the CLI is missing, the name is taken, the model is rejected, the
broker is unreachable. So the placement is not acknowledged when the pane opens;
it is acknowledged when the broker confirms the agent exists. If the agent never
appears within `creationTimeoutMs`, the handler closes the pane it opened and
fails the placement, rather than reporting a spawned agent that does not exist.

Two related rules fall out of the same principle — never report an effect you
have not confirmed, and never fail in a way that invites a duplicate:

- **Broker selection is pinned to the registered project.** A pane discovers its
  broker from its own working directory, so the pane always runs in `projectDir`
  — the project whose broker registered this provider. A placement that asks for
  a different working directory gets it via `HERDR_RELAY_SPAWN_CWD`, applied to
  the *agent* through `node agent new --cwd`. Without this split, a host running
  several project-scoped brokers would create the agent on the wrong broker, or
  none, while claiming to have targeted this node.
- **The pane label is best-effort.** `pane.rename` is cosmetic. Failing a
  placement because a label did not stick would report failure for a pane that is
  already creating the agent, and the caller's retry would open a duplicate pane
  or collide with the agent it just made. A rename failure warns and continues.

## Identity: a provider, not a new node

This plugin does **not** enroll a node. It reads the local broker's
`/api/session` for the node id and node token the broker already holds, and
attaches as a second *provider* on that same node, alongside the broker's own.

The node keeps the broker's name. `node.register` carries `name` together with
`node_id`, so serving under any other name would rename the live node out from
under every agent already placed on it. `runFleetNode` pins
`nameOverride` to the name the broker reports, and a test asserts it.

The practical consequence: **Herdr-ness is carried by the capability, not by a
separate node identity.** A placement targets the existing node (here,
`chief-broker`) and asks for `spawn:claude`; this provider shadows that
capability while the pane is open, so the agent is created as a Herdr pane
rather than as a PTY child of the broker.

Two things follow, and both are deliberate:

- The shadow is **host-wide and time-bounded**. While the node pane is open,
  *any* `spawn:claude` placement onto this node opens a Herdr pane, not only one
  a human aimed at Herdr. Closing the pane restores the broker's native spawn.
- The capability names are the ones the fleet **already advertises**. A
  Herdr-specific capability name would be unroutable by existing callers, and
  `workflow:run` is a different role entirely (it is the workflow capability and
  additionally requires `--workflow <path>`); nothing here depends on it.

## The deferred alternative

Capability-carrying is not the only option. A genuinely distinct
`herdr-<host>` fleet node is possible via `agent-relay cloud enroll`, which
enrolls the machine as a Cloud-managed node with its own node id and token. That
would let a placement target a Herdr node by name instead of shadowing a
capability on a shared one.

It is **deliberately deferred**, not ruled out. Enrolling is an account-level
action, and this machine already has an existing offline `kjg-laptop` identity;
a second enrollment should be resolved against that identity first rather than
adding a third overlapping record. Revisit this when that identity is sorted —
at which point `nameOverride` becomes the enrolled Herdr node's own name and the
shadowing behaviour above can be dropped.

## Verified end to end

Against a live `chief-broker` node (9 agents already placed on it, none
disturbed):

- A placement targeting the node for `spawn:claude` returned this provider's own
  output — `{capability: "spawn:claude", pane_id: "w3:p3", surface: "herdr-pane"}`
  — so the placement reached this handler rather than the broker's native spawn.
- `herdr agent list` showed pane `w3:p3` running Claude Code in the Chief cwd,
  and `agent-relay node agent list` showed the agent by name.
- Process ancestry: Herdr server → `fleet-agent.mjs` → `agent-relay node agent
  new` → the broker's agent PTY. The pane is the visible surface that creates and
  drives the agent; the **broker owns the agent process**, which is precisely why
  it appears in `node agent list` like any other agent. The pane is not a second
  runtime.

## Provider teardown, and how to remove a stranded provider

**Read this before running the node pane.** A provider registration is
control-plane state that outlives this process. It is not cleaned up by the
process dying.

This bit us in production. An earlier revision of this doc claimed a registered
capability "disappears with the pane" and was therefore the *honest* signal
compared to a sticky node tag. **That was wrong, and backwards.** What actually
happened:

- The node pane was closed. The process died. A teardown check confirmed zero
  local processes — and passed.
- The provider registration survived. Every subsequent `spawn:claude` placement
  onto `chief-broker` was answered
  `Provider "herdr-khaliqs-macbook-pro" is offline for action "spawn:claude"`,
  blocking native spawning for the whole host.
- Meanwhile the node tag — the residue flagged as the sticky one — had cleared on
  its own when the broker re-registered.

The capability was the sticky one. Killing the process is not teardown, because
only a **graceful stop** emits `node.deregister`.

### What the plugin now does

`runFleetNode` installs `SIGINT`/`SIGTERM`/`SIGHUP` handlers that abort the serve
loop, and does not return until `serveNode` settles — so the process cannot exit
before the deregister frame flushes. Two assertions cover it, both verified to
fail against the pre-fix teardown.

### Removing a provider that is already stranded

There is **no first-class CLI for this.** `agent-relay fleet` has no deregister
command; `fleet release` releases an *agent*, not a provider. Cleanup requires
reaching past the CLI into the SDK. The underlying primitive *is* first-class and
supported — `NodeProviderClient.stop()` is documented as "Gracefully deregister
the provider and close the connection" — but nothing operator-facing calls it.

The supported call, composed from two documented SDK behaviours:

1. `openSocket()` — "A fresh instance id per connection: reconnecting with a new
   id replaces the previous attachment (the engine's reconnect-vs-duplicate
   arbitration)." Re-attaching under the **same provider name** evicts the stale
   attachment.
2. `stop()` — sends `{ type: 'node.deregister', provider: { name, instance_id } }`.

So: `serveNode` under the stranded provider's exact name, then abort its signal.

**Prerequisites**

- The local broker must be running; its `/api/session` supplies `node_id` and the
  `nt_live_` node token.
- `nameOverride` **must** be the broker's own node name. Anything else renames the
  live node (see above).
- Register a **harmless** capability, never `spawn:<cli>`. The replacement is
  attached for a moment, and re-registering the contested capability would let it
  intercept a placement that raced the cleanup.

**Control-plane verification — do not trust the deregister return.** The frame
being sent is not proof it took effect, and the public node record does not list
providers: `agent-relay fleet nodes --all` and `query_nodes` show only deduped
capabilities with kind `capacity`, in which a provider is invisible whether it is
attached, stale, or gone. Verify on routing behaviour instead, which is the
contract callers actually depend on:

- Issue a real placement for the contested capability at the node.
- It must not return `Provider ... is offline`.
- Its output must be the **broker's** native shape (`{"name":…,"spawned":true}`),
  not this plugin's (`{…, "pane_id":…, "surface":"herdr-pane"}`). Different shape,
  different executor.
- No Herdr pane and no `fleet-agent` process should exist.
- Have the spawned agent reply, so you know it is live rather than merely
  registered. Then release it.

## A green check can mean a review that never ran

Recorded here because it is a reusable trap, not a detail of one PR.

PR #2 was opened against `codex/t3-chief-fleet-picker` rather than `main`, since
it is stacked. Its checks rollup then read, in full:

```
test (ubuntu-latest)      SUCCESS
test (macos-latest)       SUCCESS
test (windows-latest)     SUCCESS
cubic · AI code reviewer  SUCCESS    "AI review completed"
CodeRabbit                SUCCESS    "Review skipped: reviews are disabled for this base branch"
```

Every check is green, and one of them is a reviewer that **inspected zero lines
of the diff**. CodeRabbit disables auto review on any non-default base branch and
reports that skip as a *success*, which is indistinguishable at a glance from a
review that ran and found nothing.

Who actually read the diff on #2:

| Reviewer | Inspected the diff? | Evidence |
|---|---|---|
| `chatgpt-codex-connector` | **yes** | 3 inline comments (2 P1, 1 P2) — and it publishes no check run at all |
| `cubic-dev-ai` | **yes** | 1 inline comment (P2); check run reports success |
| CodeRabbit | **no** | skipped on non-default base; check still SUCCESS |
| cursor bugbot | **no** | not enabled for the account; posts a comment, no check |

Two lessons worth carrying:

- **Treat reviewer execution as evidence to verify, not to assume.** Read the
  check's *description*, not its colour. Ask which reviewers commented, and
  reconcile that against which ones were expected.
- **A stacked PR silently loses reviewers.** Basing on a non-default branch is
  the right call for a dependent change, but it costs coverage that nothing
  warns you about. When stacking, re-trigger the skipped reviewer explicitly.

Codex is the inverse trap: it found both P1 defects here while publishing no
check run whatsoever, so a rollup-only reading would have missed the reviewer
that mattered most.

## Configuration

| Variable | Effect |
|---|---|
| `HERDR_RELAY_PROJECT_DIR` | Project whose broker to serve; defaults to the active Herdr workspace cwd |
| `HERDR_RELAY_NODE_CAPABILITIES` | Comma-separated `spawn:<cli>` list; defaults to `spawn:claude,spawn:codex` |
| `HERDR_RELAY_NODE_PROVIDER` | Provider name; defaults to `herdr-<hostname>` |
| `HERDR_RELAY_ATTACH_MODE` | `drive`, `view`, or `passthrough` for the panes it opens |

The node token is read from the broker and handed to the fleet runtime. It is
never logged and never written to disk by this plugin.
