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

## Configuration

| Variable | Effect |
|---|---|
| `HERDR_RELAY_PROJECT_DIR` | Project whose broker to serve; defaults to the active Herdr workspace cwd |
| `HERDR_RELAY_NODE_CAPABILITIES` | Comma-separated `spawn:<cli>` list; defaults to `spawn:claude,spawn:codex` |
| `HERDR_RELAY_NODE_PROVIDER` | Provider name; defaults to `herdr-<hostname>` |
| `HERDR_RELAY_ATTACH_MODE` | `drive`, `view`, or `passthrough` for the panes it opens |

The node token is read from the broker and handed to the fleet runtime. It is
never logged and never written to disk by this plugin.
