import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { action, defineNode, serveNode } from '@agent-relay/fleet';
import { z } from 'zod';

import {
  BrokerUnavailableError,
  attachMode,
  fleetProjectDir,
  installStopHandlers,
  listBrokerAgents,
  openedPane,
} from './fleet.mjs';
import { requestHerdr } from './herdr-socket.mjs';

/** Panes the node opens run the same entrypoint the picker uses. */
export const FLEET_AGENT_ENTRYPOINT = 'fleet-agent';

/**
 * Capabilities the Herdr node serves by default. These are deliberately the
 * capability names the fleet already advertises rather than a Herdr-specific
 * one: a placement targeting this node for `spawn:claude` should get a Herdr
 * pane, which only works if the node answers the name callers already use.
 */
export const DEFAULT_NODE_CAPABILITIES = ['spawn:claude', 'spawn:codex'];

export const BROKER_STATE_DIR = '.agentworkforce/relay';

const spawnInput = z
  .looseObject({
    name: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    cli: z.string().min(1).optional(),
    task: z.string().optional(),
    model: z.string().min(1).optional(),
    channels: z.array(z.string().min(1)).optional(),
    cwd: z.string().min(1).optional(),
  })
  .refine((input) => Boolean(input.name ?? input.agent), {
    message: 'spawn input requires name or agent',
    path: ['name'],
  });

export { spawnInput };

/**
 * The provider identity this plugin attaches under. It is deliberately NOT the
 * node name — see `runFleetNode` — so it stays distinct from the broker's own
 * provider on the same node.
 */
export function herdrProviderName(host = hostname()) {
  const slug = String(host)
    .toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `herdr-${slug || 'host'}`;
}

/** `spawn:claude` names the CLI the pane should launch. */
export function capabilityCli(capability) {
  const prefix = 'spawn:';
  if (!capability.startsWith(prefix)) {
    throw new Error(`Herdr fleet node capabilities must be spawn:<cli>, got "${capability}"`);
  }
  const cli = capability.slice(prefix.length).trim();
  if (!cli) throw new Error(`Herdr fleet node capability "${capability}" names no CLI`);
  return cli;
}

export function parseCapabilities(value) {
  if (typeof value !== 'string' || !value.trim()) return [...DEFAULT_NODE_CAPABILITIES];
  const names = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!names.length) return [...DEFAULT_NODE_CAPABILITIES];
  for (const name of names) capabilityCli(name);
  return names;
}

/**
 * Read the local broker's connection file. The broker owns this file; the node
 * only borrows its URL and key to ask the broker who it is.
 */
export async function readBrokerConnection(projectDir, { read = readFile } = {}) {
  const path = join(projectDir, BROKER_STATE_DIR, 'connection.json');
  let raw;
  try {
    raw = await read(path, 'utf8');
  } catch (cause) {
    throw new BrokerUnavailableError(projectDir, { cause });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`The local broker connection file at ${path} is not valid JSON`, { cause });
  }
  const url = typeof parsed?.url === 'string' ? parsed.url.trim() : '';
  const apiKey = typeof parsed?.api_key === 'string' ? parsed.api_key.trim() : '';
  if (!url || !apiKey) {
    throw new Error(`The local broker connection file at ${path} names no broker url and key`);
  }
  return { url, apiKey };
}

/**
 * Ask the running broker for the node it registered as. The broker mints the
 * node token, so a Herdr pane never needs its own enrollment — it attaches as a
 * second provider on the node this machine already runs.
 *
 * The returned token is a live credential: it is passed to the fleet runtime and
 * never logged.
 */
export async function readNodeIdentity({ url, apiKey }, { fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${url}/api/session`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
  } catch (cause) {
    throw new Error(`The local broker at ${url} did not answer a node identity request`, { cause });
  }
  if (!response.ok) {
    throw new Error(
      `The local broker at ${url} refused the node identity request (HTTP ${response.status})`
    );
  }
  const session = await response.json();
  const nodeId = typeof session?.node_id === 'string' ? session.node_id.trim() : '';
  const nodeName = typeof session?.node_name === 'string' ? session.node_name.trim() : '';
  const nodeToken = typeof session?.node_token === 'string' ? session.node_token.trim() : '';
  if (!nodeId || !nodeName) {
    throw new Error('The local broker has not registered a fleet node yet');
  }
  if (!nodeToken) {
    throw new Error(
      'The local broker reported no node token, so this Herdr host cannot serve fleet capabilities. ' +
        'Set RELAY_NODE_TOKEN, or restart the broker so it mints one.'
    );
  }
  return { nodeId, nodeName, nodeToken };
}

export const DEFAULT_CREATION_TIMEOUT_MS = 60_000;
export const DEFAULT_CREATION_POLL_MS = 1_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block until the broker actually holds the agent the pane was asked to create.
 *
 * Opening a pane only starts `agent-relay node agent new` in it; creation can
 * still fail afterwards (CLI missing, name taken, model rejected, broker down).
 * Resolving the placement at pane-open time would report a spawned agent that
 * does not exist, so the acknowledgement waits for the broker to confirm.
 */
export function agentIdentity(agent) {
  const sessionId = typeof agent?.sessionId === 'string' ? agent.sessionId.trim() : '';
  return sessionId ? `session:${sessionId}` : `name:${agent?.name}`;
}

export async function waitForBrokerAgent({
  agentName,
  projectDir,
  listAgents,
  knownIdentities,
  timeoutMs = DEFAULT_CREATION_TIMEOUT_MS,
  pollMs = DEFAULT_CREATION_POLL_MS,
  sleep = delay,
  now = () => Date.now(),
}) {
  const deadline = now() + timeoutMs;
  let lastFailure;
  for (;;) {
    try {
      const agents = await listAgents(projectDir);
      const match = agents.find((agent) => agent?.name === agentName);
      // Presence is not creation. A record already in the pre-spawn snapshot is
      // not evidence this placement produced anything — and `node agent new`
      // fails precisely BECAUSE a name is taken, so the colliding record would
      // otherwise be reported as this placement's success.
      if (match && !knownIdentities?.has(agentIdentity(match))) return true;
      lastFailure = undefined;
    } catch (error) {
      // A broker that cannot be queried is not proof the agent is absent; keep
      // polling until the deadline, then report the query failure as the cause.
      lastFailure = error;
    }
    if (now() >= deadline) {
      throw new Error(
        `${agentName} never appeared on the broker for ${projectDir} within ${timeoutMs}ms` +
          (lastFailure ? `; the last broker query failed: ${lastFailure.message}` : ''),
        lastFailure ? { cause: lastFailure } : undefined
      );
    }
    await sleep(pollMs);
  }
}

/**
 * Build the handler a placement invokes. It opens a real Herdr pane and lets the
 * pane's own projector report state, so `pane.report_agent` keeps exactly one
 * writer per pane rather than racing the node against it.
 */
export function createPaneSpawnHandler({
  socketPath,
  pluginId,
  projectDir,
  mode,
  request = requestHerdr,
  logger = console,
  listAgents = listBrokerAgents,
  creationTimeoutMs = DEFAULT_CREATION_TIMEOUT_MS,
  creationPollMs = DEFAULT_CREATION_POLL_MS,
  sleep = delay,
}) {
  // `node agent new` has no request-id or caller-supplied session-id. Keep
  // placements reaching this provider from racing each other for the same name
  // during the list -> open-pane -> list interval; the broker would otherwise
  // expose one placement's new record as evidence for the other.
  const pendingAgentNames = new Set();

  return async function spawnPane(input, capability) {
    const agentName = (input.name ?? input.agent).trim();
    const cli = (input.cli ?? capabilityCli(capability)).trim();
    // Where the AGENT works. Distinct from projectDir, which selects the broker.
    const agentCwd = input.cwd?.trim() || projectDir;

    if (pendingAgentNames.has(agentName)) {
      throw new Error(
        `A placement for agent "${agentName}" is already being created on the broker for ${projectDir}. ` +
          'Wait for it to finish, or place this agent under a different name.'
      );
    }
    pendingAgentNames.add(agentName);

    try {

    // Snapshot BEFORE opening anything. Two jobs: refuse a name that is already
    // taken, and record identities so the later wait can require an
    // absent->present transition rather than mere presence.
    const before = await listAgents(projectDir);
    const collision = before.find((agent) => agent?.name === agentName);
    if (collision) {
      throw new Error(
        `An agent named "${agentName}" is already running on the broker for ${projectDir}. ` +
          'Release it first, or place this agent under a different name. ' +
          'Spawning would fail on the name collision, and the existing agent is not this placement\'s to report.'
      );
    }
    const knownIdentities = new Set(before.map(agentIdentity));

    // No workspace_id: the pane lands in the focused Herdr workspace, which is
    // what makes it visible to whoever is sitting in front of Herdr.
    //
    // The pane's own cwd is always projectDir. The pane discovers its broker
    // from its working directory, so running it in a placement-supplied cwd
    // would let it create the agent on a different project's broker — or none —
    // while the placement claimed to target this node. A requested working
    // directory travels as HERDR_RELAY_SPAWN_CWD and is applied to the agent.
    const response = await request(socketPath, 'plugin.pane.open', {
      plugin_id: pluginId,
      entrypoint: FLEET_AGENT_ENTRYPOINT,
      placement: 'tab',
      cwd: projectDir,
      focus: true,
      env: {
        HERDR_RELAY_AGENT_NAME: agentName,
        HERDR_RELAY_AGENT_LABEL: cli,
        HERDR_RELAY_ATTACH_MODE: mode,
        HERDR_RELAY_SPAWN_CLI: cli,
        ...(agentCwd === projectDir ? {} : { HERDR_RELAY_SPAWN_CWD: agentCwd }),
        ...(input.task ? { HERDR_RELAY_SPAWN_TASK: input.task } : {}),
        ...(input.model ? { HERDR_RELAY_SPAWN_MODEL: input.model } : {}),
        ...(input.channels?.length ? { HERDR_RELAY_SPAWN_CHANNELS: input.channels.join(',') } : {}),
      },
    });
    const pane = openedPane(response);

    // The label is cosmetic. Failing the placement on it would report a failure
    // for a pane that is already creating the agent, and the caller's retry
    // would open a duplicate pane or collide with the agent it just made.
    try {
      await request(socketPath, 'pane.rename', { pane_id: pane.pane_id, label: agentName });
    } catch (error) {
      logger.warn(`Could not label pane ${pane.pane_id} as "${agentName}": ${error.message}`);
    }

    try {
      await waitForBrokerAgent({
        agentName,
        projectDir,
        listAgents,
        knownIdentities,
        timeoutMs: creationTimeoutMs,
        pollMs: creationPollMs,
        sleep,
      });
    } catch (error) {
      // Nothing was created, so leave no pane behind claiming otherwise.
      await request(socketPath, 'pane.close', { pane_id: pane.pane_id }).catch(() => undefined);
      throw error;
    }

    logger.log(
      `Opened Herdr pane ${pane.pane_id} running ${cli} agent "${agentName}" in ${agentCwd} ` +
        `on the broker for ${projectDir}.`
    );
    return {
      agent: agentName,
      cli,
      capability,
      pane_id: pane.pane_id,
      cwd: agentCwd,
      projectDir,
      surface: 'herdr-pane',
    };
    } finally {
      pendingAgentNames.delete(agentName);
    }
  };
}

export function buildNodeDefinition({ providerName, capabilities, handler, maxAgents }) {
  const declared = {};
  for (const capability of capabilities) {
    declared[capability] = action(
      { input: spawnInput, metadata: { surface: 'herdr-pane', cli: capabilityCli(capability) } },
      (input) => handler(input, capability)
    );
  }
  // Deliberately no tags. A tag set here is written onto the shared node record
  // and survives the provider detaching, so the node would keep advertising
  // "herdr" long after the pane that could serve it closed.
  //
  // Note the capability registration is NOT self-clearing either — that was an
  // earlier and costly misreading. It survives the process too, and only a
  // graceful stop deregisters it (see the teardown handling in runFleetNode).
  // The difference is that a stranded capability can be deregistered, while a
  // tag can only be overwritten by the record's owner.
  return defineNode({
    name: providerName,
    capabilities: declared,
    ...(maxAgents === undefined ? {} : { maxAgents }),
  });
}

export async function runFleetNode({
  environment = process.env,
  request = requestHerdr,
  serve = serveNode,
  readConnection = readBrokerConnection,
  readIdentity = readNodeIdentity,
  logger = console,
  signal,
  installHandlers = installStopHandlers,
  stopTarget = process,
} = {}) {
  const socketPath = environment.HERDR_SOCKET_PATH;
  if (!socketPath) throw new Error('Herdr did not provide HERDR_SOCKET_PATH');
  const pluginId = environment.HERDR_PLUGIN_ID;
  if (!pluginId) throw new Error('Herdr did not provide HERDR_PLUGIN_ID');

  const projectDir = fleetProjectDir(environment);
  const mode = attachMode(environment.HERDR_RELAY_ATTACH_MODE);
  const capabilities = parseCapabilities(environment.HERDR_RELAY_NODE_CAPABILITIES);
  const providerName = environment.HERDR_RELAY_NODE_PROVIDER?.trim() || herdrProviderName();

  const identity = await readIdentity(await readConnection(projectDir));
  const handler = createPaneSpawnHandler({ socketPath, pluginId, projectDir, mode, request, logger });
  const definition = buildNodeDefinition({ providerName, capabilities, handler });

  logger.log(
    `Serving ${capabilities.join(', ')} as provider "${providerName}" on node "${identity.nodeName}" ` +
      `for ${projectDir}. Placements targeting this node open Herdr panes.`
  );

  // Teardown is not optional. A provider registration is control-plane state
  // that OUTLIVES this process: killing the pane strands it, and every later
  // placement for its capabilities is answered with "Provider ... is offline"
  // until someone deregisters it. Only a graceful stop emits `node.deregister`,
  // so Herdr's shutdown signals must reach the serve loop, and this function
  // must not resolve until serve settles — returning early would let the process
  // exit before the deregister frame flushes, which is the same stranded state.
  const controller = new AbortController();
  const stop = () => controller.abort();
  installHandlers(stopTarget, stop);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', stop, { once: true });
  }

  await serve({
    definition,
    connection: { nodeToken: identity.nodeToken, nodeId: identity.nodeId },
    // The node's NAME must stay the broker's own. `node.register` carries name
    // alongside node_id, so serving under any other name would rename the live
    // node out from under every agent already placed on it.
    nameOverride: identity.nodeName,
    providerName,
    reconnect: true,
    signal: controller.signal,
    log: (message) => logger.log(message),
    warn: (message) => logger.error(message),
  });
  // Deliberately does NOT claim a deregistration. serveNode settling proves the
  // serve loop stopped, not that `node.deregister` was sent: the SDK gates that
  // frame on the socket still being open and registered, then settles either
  // way. Claiming it here would be a log that lies precisely when teardown
  // failed — the case that caused an outage once already.
  logger.log(`Stopped serving provider "${providerName}" on node "${identity.nodeName}".`);
}

export function isDirectEntrypoint(moduleUrl, argv1) {
  return Boolean(argv1) && moduleUrl === pathToFileURL(argv1).href;
}

export function waitForDismiss(input = process.stdin, output = process.stdout) {
  if (!input.isTTY) return Promise.resolve();
  output.write('\nPress Enter to close this pane.\n');
  input.setEncoding('utf8');
  input.resume();
  return new Promise((resolve) => input.once('data', resolve));
}

export async function main({ dismiss = waitForDismiss } = {}) {
  try {
    await runFleetNode();
  } catch (error) {
    console.error(`Agent Relay fleet node failed: ${error.message}`);
    process.exitCode = 1;
    await dismiss();
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) await main();
