import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';

import { AgentRelay } from '@agent-relay/sdk';

import { bridgeName } from './bridge.mjs';
import { BridgeConfigSchema, configPath, pluginPaths, writeBridgeConfig } from './config.mjs';
import { requestHerdr } from './herdr-socket.mjs';
import { acquireBridgeLock, loadBridgeState, saveBridgeState } from './state.mjs';

const DEFAULT_CHANNEL = '#agent-status';

export function workspaceChoicesFrom(response) {
  const snapshot = response?.result?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.workspaces)) {
    throw new Error('Herdr returned an invalid session snapshot');
  }
  return snapshot.workspaces
    .filter((workspace) => typeof workspace.workspace_id === 'string' && workspace.workspace_id)
    .map((workspace) => ({
      workspaceId: workspace.workspace_id,
      label: typeof workspace.label === 'string' ? workspace.label : '',
    }));
}

export function proposedConfig(workspaceKey, choices, channel = DEFAULT_CHANNEL) {
  const candidate = {
    workspaceKey,
    channel,
    workspaceIds: choices.map((choice) => choice.workspaceId),
  };
  const result = BridgeConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error('Generated Agent Relay bridge configuration is invalid');
  }
  return result.data;
}

// Registers under the name the bridge would use and stores the token, so the
// bridge reconnects instead of registering a second Relay agent. The channel
// must exist before the bridge joins it, and channel creation is agent-scoped.
//
// `existingKey` joins a workspace that already exists — the case that matters
// when the fleet should be visible to agents already living there, rather than
// isolated in a workspace of its own.
async function provisionWorkspace(socketPath, channel, AgentRelayCtor, logger, existingKey) {
  const relay = existingKey
    ? new AgentRelayCtor({ workspaceKey: existingKey })
    : await AgentRelayCtor.createWorkspace({ name: bridgeName(socketPath) });
  const workspaceKey = existingKey ?? relay.workspaceKey;
  if (!workspaceKey) throw new Error('Agent Relay did not return a workspace key');
  logger.log(existingKey ? '  using the existing Relay workspace' : '  workspace created');

  const agent = await relay.workspace.register({
    name: bridgeName(socketPath),
    type: 'agent',
    metadata: { integration: 'herdr' },
  });
  if (!agent.token) throw new Error('Agent Relay registration did not return an agent token');
  logger.log(`  bridge agent registered as ${agent.name}`);

  // Joining an existing workspace usually means the channel is already there.
  try {
    await agent.channels.create({ name: channel.slice(1), topic: 'Herdr agent status' });
    logger.log(`  channel ${channel} created`);
  } catch (error) {
    await agent.channels.join(channel);
    logger.log(`  channel ${channel} already existed, joined it`);
  }

  return { workspaceKey, apiToken: agent.token };
}

export async function runSetup({
  environment = process.env,
  AgentRelayCtor = AgentRelay,
  logger = console,
  channel = environment.HERDR_RELAY_CHANNEL || DEFAULT_CHANNEL,
} = {}) {
  const { configDir, stateDir } = pluginPaths(environment);
  const socketPath = environment.HERDR_SOCKET_PATH;
  if (!socketPath) throw new Error('Herdr did not provide HERDR_SOCKET_PATH');
  const existingKey = environment.HERDR_RELAY_WORKSPACE_KEY;

  const target = configPath(configDir);
  // Never clobber an existing workspace key: losing it orphans the Relay
  // workspace and every agent registered against it.
  const existing = await readIfPresent(target);
  if (existing) {
    logger.log(`Agent Relay bridge is already configured at ${target}.`);
    logger.log('Edit that file to change the channel or workspace allowlist, then reopen the bridge pane.');
    return { alreadyConfigured: true, configPath: target };
  }

  const lock = await acquireBridgeLock(stateDir);
  try {
    logger.log(`Setting up the Agent Relay bridge for ${hostname()}...`);

    await requestHerdr(socketPath, 'ping');
    const choices = workspaceChoicesFrom(await requestHerdr(socketPath, 'session.snapshot'));
    if (!choices.length) {
      throw new Error('Herdr reported no workspaces to forward; open a workspace first');
    }

    const { workspaceKey, apiToken } = await provisionWorkspace(
      socketPath,
      channel,
      AgentRelayCtor,
      logger,
      existingKey
    );

    const config = proposedConfig(workspaceKey, choices, channel);
    await writeBridgeConfig(configDir, config);
    logger.log(`  config written to ${target} (0600)`);

    const state = await loadBridgeState(stateDir);
    state.apiToken = apiToken;
    await saveBridgeState(stateDir, state);
    logger.log('  bridge token saved');

    logger.log('');
    logger.log(`Forwarding ${config.workspaceIds.length} workspace(s): ${describe(choices)}`);
    logger.log('Edit the config to narrow that list before starting the bridge.');
    logger.log('');
    logger.log('Start the bridge with:');
    logger.log('  herdr plugin pane open --plugin agent-relay.herdr-bridge --entrypoint bridge');

    return { alreadyConfigured: false, configPath: target, config };
  } finally {
    await lock.release().catch(() => undefined);
  }
}

function describe(choices) {
  return choices
    .map((choice) => (choice.label ? `${choice.workspaceId} (${choice.label})` : choice.workspaceId))
    .join(', ');
}

async function readIfPresent(path) {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function isDirectEntrypoint(moduleUrl, argv1) {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  runSetup().catch((error) => {
    console.error(`Agent Relay bridge setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
