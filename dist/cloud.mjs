import { ensureCloudSession } from '@agent-relay/cloud';
import { HarnessDriverClient } from '@agent-relay/harness-driver';

export const CLOUD_WORKSPACE_PATH = '/workspace';
export const DEFAULT_WARM_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_WARM_POLL_MS = 2_000;
export const SUPPORTED_CLOUD_HARNESSES = new Set([
  'claude',
  'codex',
  'gemini',
  'opencode',
  'droid',
  'copilot',
  'aider',
  'grok',
]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function responseJson(response, operation) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = safeCloudError(payload);
    throw new Error(`${operation} failed (HTTP ${response.status})${detail}`);
  }
  return payload;
}

export function safeCloudError(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const raw = typeof payload.error === 'string' ? payload.error : '';
  if (/expired|invalid[_ -]?grant|invalid[_ -]?refresh[_ -]?token/i.test(raw)) {
    return ': provider credential expired; reconnect it in Agent Relay Cloud';
  }
  if (/warm exhausted retries/i.test(raw)) return ': sandbox warm exhausted retries';
  if (/daytona.*(?:unresponsive|timeout)|(?:timeout|timed out).*daytona/i.test(raw)) {
    return ': Daytona is temporarily unavailable';
  }
  const code = typeof payload.code === 'string' && /^[a-z0-9_-]+$/i.test(payload.code)
    ? payload.code
    : '';
  return code ? `: ${code}` : '';
}

function requiredText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`Cloud response did not include ${label}`);
  return text;
}

export function cloudWorkspaceId(whoami, explicitId) {
  if (typeof explicitId === 'string' && explicitId.trim()) return explicitId.trim();
  return requiredText(whoami?.currentWorkspace?.id, 'an active workspace id');
}

export function selectCloudAgent(payload, selector, harnessSelector) {
  const agents = Array.isArray(payload) ? payload : payload?.agents;
  if (!Array.isArray(agents)) throw new Error('Cloud returned an invalid cloud-agent list');
  const wantedHarness = typeof harnessSelector === 'string' ? harnessSelector.trim() : '';
  const available = agents.filter((agent) => {
    const harness = typeof agent?.harness === 'string' ? agent.harness.trim() : '';
    return (
      agent &&
      typeof agent.id === 'string' &&
      agent.id.trim() &&
      agent.isActive !== false &&
      SUPPORTED_CLOUD_HARNESSES.has(harness) &&
      (!wantedHarness || harness === wantedHarness)
    );
  });
  const wanted = typeof selector === 'string' ? selector.trim() : '';
  if (wanted) {
    const match = available.find((agent) =>
      [agent.id, agent.name, agent.displayName].some(
        (value) => typeof value === 'string' && value.trim() === wanted
      )
    );
    if (!match) throw new Error('The requested Cloud agent is not active in this workspace');
    return match;
  }
  if (available.length === 1) return available[0];
  if (available.length === 0) {
    throw new Error(
      wantedHarness
        ? `No active ${wantedHarness} Cloud agent is configured in this workspace`
        : 'No active coding Cloud agent is configured in this workspace'
    );
  }
  throw new Error(
    'More than one Cloud agent matches; set HERDR_RELAY_CLOUD_AGENT_ID or ' +
      'HERDR_RELAY_CLOUD_HARNESS to choose one'
  );
}

export function cloudPaneAgentName(agent, explicitName) {
  if (typeof explicitName === 'string' && explicitName.trim()) return explicitName.trim();
  const harness = typeof agent?.harness === 'string' && agent.harness.trim()
    ? agent.harness.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    : 'agent';
  const id = requiredText(agent?.id, 'a cloud agent id').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8);
  return `cloud-${harness}-${id || 'agent'}`;
}

export function normalizeCloudBox(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Cloud returned an invalid sandbox response');
  }
  const status = requiredText(payload.status, 'a sandbox status');
  if (!['warming', 'ready', 'failed', 'stopping', 'stopped'].includes(status)) {
    throw new Error(`Cloud returned unsupported sandbox status "${status}"`);
  }
  const box = {
    sandboxId: requiredText(payload.sandboxId, 'a sandbox id'),
    relayfileMountPath: requiredText(payload.relayfileMountPath, 'a Relayfile mount path'),
    status,
    ...(typeof payload.execUrl === 'string' && payload.execUrl.trim()
      ? { execUrl: payload.execUrl.trim() }
      : {}),
    ...(typeof payload.apiKey === 'string' && payload.apiKey.trim()
      ? { apiKey: payload.apiKey.trim() }
      : {}),
    ...(typeof payload.error === 'string' && payload.error.trim()
      ? { error: safeCloudError({ error: payload.error }).replace(/^: /, '') || 'sandbox failed' }
      : {}),
  };
  if (status === 'ready' && !box.execUrl) {
    throw new Error('Ready Cloud sandbox response did not include a broker URL');
  }
  // Deliberately exclude relayfileToken. Herdr only needs the broker stream;
  // the sandbox mount daemon already owns the Relayfile credential.
  return box;
}

export async function warmCloudBox({
  client,
  workspaceId,
  cloudAgentId,
  mountPath = CLOUD_WORKSPACE_PATH,
  timeoutMs = DEFAULT_WARM_TIMEOUT_MS,
  pollMs = DEFAULT_WARM_POLL_MS,
  sleep = delay,
  now = () => Date.now(),
}) {
  const path =
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}` +
    `/cloud-agents/${encodeURIComponent(cloudAgentId)}/box`;
  const initial = await responseJson(
    await client.fetch(`${path}?async=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        relayfileMountPaths: [mountPath],
        workspaceSource: { kind: 'relayfile' },
        requireRelayfileMount: true,
        brokerName: `herdr-${cloudAgentId.slice(0, 8)}`,
      }),
    }),
    'Cloud sandbox warm'
  );
  let box = normalizeCloudBox(initial);
  const deadline = now() + timeoutMs;
  while (box.status === 'warming') {
    if (now() >= deadline) {
      throw new Error(`Cloud sandbox did not become ready within ${timeoutMs}ms`);
    }
    await sleep(pollMs);
    box = normalizeCloudBox(
      await responseJson(await client.fetch(path, { method: 'GET' }), 'Cloud sandbox status')
    );
  }
  if (box.status === 'failed') throw new Error(box.error || 'Cloud sandbox warm failed');
  if (box.status !== 'ready') throw new Error(`Cloud sandbox is ${box.status}`);
  return box;
}

export async function ensureCloudBrokerAgent({
  box,
  cloudAgent,
  agentName,
  task,
  channels,
  createClient = (options) => new HarnessDriverClient(options),
}) {
  const client = createClient({
    baseUrl: box.execUrl,
    ...(box.apiKey ? { apiKey: box.apiKey } : {}),
  });
  try {
    await client.getSession();
    let agents = await client.listAgents();
    let agent = agents.find((candidate) => candidate.name === agentName);
    if (!agent) {
      const cli = requiredText(cloudAgent?.harness, 'a Cloud agent harness');
      let spawnError;
      try {
        await client.spawnCli({
          name: agentName,
          cli,
          transport: 'pty',
          cwd: box.relayfileMountPath,
          ...(typeof cloudAgent.defaultModel === 'string' && cloudAgent.defaultModel.trim()
            ? { model: cloudAgent.defaultModel.trim() }
            : {}),
          ...(typeof task === 'string' && task.trim() ? { task: task.trim() } : {}),
          ...(channels?.length ? { channels } : {}),
        });
      } catch (cause) {
        // Another picker may have won the check-then-spawn race for this stable
        // name. Re-list before surfacing the error so both pickers converge on
        // the broker agent that now exists.
        spawnError = cause;
      }
      agents = await client.listAgents();
      agent = agents.find((candidate) => candidate.name === agentName);
      if (!agent && spawnError) throw spawnError;
      if (!agent) throw new Error('Cloud broker did not report the agent it just spawned');
    }
    return agent;
  } finally {
    client.disconnect?.();
  }
}

export async function prepareCloudPane({
  environment = process.env,
  openCloudSession = () => ensureCloudSession({ interactive: false, env: environment }),
  createBrokerClient,
  sleep,
  now,
} = {}) {
  let session;
  try {
    session = await openCloudSession();
  } catch (cause) {
    throw new Error('Cloud login is required; run `agent-relay login`, then retry', { cause });
  }
  const whoami = await responseJson(
    await session.client.fetch('/api/v1/auth/whoami', { method: 'GET' }),
    'Cloud identity lookup'
  );
  const workspaceId = cloudWorkspaceId(whoami, environment.HERDR_RELAY_CLOUD_WORKSPACE_ID);
  const cloudAgent = selectCloudAgent(
    await responseJson(
      await session.client.fetch('/api/v1/cloud-agents', { method: 'GET' }),
      'Cloud agent listing'
    ),
    environment.HERDR_RELAY_CLOUD_AGENT_ID,
    environment.HERDR_RELAY_CLOUD_HARNESS
  );
  const agentName = cloudPaneAgentName(cloudAgent, environment.HERDR_RELAY_AGENT_NAME);
  const box = await warmCloudBox({
    client: session.client,
    workspaceId,
    cloudAgentId: cloudAgent.id,
    mountPath: environment.HERDR_RELAY_CLOUD_MOUNT_PATH?.trim() || CLOUD_WORKSPACE_PATH,
    ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}),
  });
  const channels = (environment.HERDR_RELAY_SPAWN_CHANNELS || '')
    .split(',')
    .map((channel) => channel.trim())
    .filter(Boolean);
  const agent = await ensureCloudBrokerAgent({
    box,
    cloudAgent,
    agentName,
    task: environment.HERDR_RELAY_SPAWN_TASK,
    channels,
    ...(createBrokerClient ? { createClient: createBrokerClient } : {}),
  });
  return {
    box,
    cloudAgent: {
      id: cloudAgent.id,
      harness: cloudAgent.harness,
      displayName: cloudAgent.displayName,
    },
    agent,
    agentName,
  };
}
