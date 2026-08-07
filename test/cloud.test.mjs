import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  cloudPaneAgentName,
  ensureCloudBrokerAgent,
  normalizeCloudBox,
  safeCloudError,
  selectCloudAgent,
  warmCloudBox,
} from '../dist/cloud.mjs';
import { runCloudPicker } from '../dist/cloud-picker.mjs';
import { runFleetAgent } from '../dist/fleet-agent.mjs';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

const CLOUD_AGENT = {
  id: 'agent-1234567890',
  displayName: 'Claude account',
  harness: 'claude',
  defaultModel: 'claude-sonnet-4-6',
  isActive: true,
};

test('selects one active Cloud agent or requires an explicit choice', () => {
  assert.equal(selectCloudAgent({ agents: [CLOUD_AGENT] }).id, CLOUD_AGENT.id);
  assert.equal(
    selectCloudAgent({ agents: [CLOUD_AGENT, { ...CLOUD_AGENT, id: 'agent-2' }] }, 'agent-2').id,
    'agent-2'
  );
  assert.equal(
    selectCloudAgent(
      { agents: [CLOUD_AGENT, { ...CLOUD_AGENT, id: 'agent-2', harness: 'codex' }] },
      undefined,
      'codex'
    ).id,
    'agent-2'
  );
  assert.throws(
    () => selectCloudAgent({ agents: [CLOUD_AGENT, { ...CLOUD_AGENT, id: 'agent-2' }] }),
    /HERDR_RELAY_CLOUD_AGENT_ID/
  );
  assert.throws(() => selectCloudAgent({ agents: [] }), /No active coding Cloud agent/);
  assert.throws(
    () => selectCloudAgent({ agents: [{ ...CLOUD_AGENT, harness: 'daytona' }] }),
    /No active coding Cloud agent/
  );
});

test('derives a stable broker-agent name without exposing account labels', () => {
  assert.equal(cloudPaneAgentName(CLOUD_AGENT), 'cloud-claude-agent123');
  assert.equal(cloudPaneAgentName(CLOUD_AGENT, 'reviewer'), 'reviewer');
});

test('cloud box normalization drops the Relayfile token', () => {
  const box = normalizeCloudBox({
    sandboxId: 'sandbox-1',
    status: 'ready',
    execUrl: 'https://sandbox.example',
    apiKey: 'broker-key',
    relayfileToken: 'must-not-leave-cloud-client',
    relayfileMountPath: '/workspace',
  });
  assert.deepEqual(box, {
    sandboxId: 'sandbox-1',
    status: 'ready',
    execUrl: 'https://sandbox.example',
    apiKey: 'broker-key',
    relayfileMountPath: '/workspace',
  });
  assert.equal('relayfileToken' in box, false);
});

test('Cloud failures are classified without echoing provider payloads', () => {
  const raw = 'invalid_refresh_token for user@example.test at https://provider.example';
  const safe = safeCloudError({ error: raw });
  assert.match(safe, /provider credential expired/);
  assert.doesNotMatch(safe, /example|https|invalid_refresh_token/);
  assert.equal(safeCloudError({ code: 'box_not_running', error: 'opaque details' }), ': box_not_running');
});

test('warms a Daytona box in Relayfile mode and polls until its broker is ready', async () => {
  const calls = [];
  const responses = [
    jsonResponse({
      sandboxId: 'sandbox-1',
      status: 'warming',
      relayfileToken: 'ignored',
      relayfileMountPath: '/workspace',
    }, 202),
    jsonResponse({
      sandboxId: 'sandbox-1',
      status: 'ready',
      execUrl: 'https://sandbox.example',
      apiKey: 'broker-key',
      relayfileToken: 'ignored',
      relayfileMountPath: '/workspace',
    }),
  ];
  const client = {
    fetch: async (path, init) => {
      calls.push({ path, init });
      return responses.shift();
    },
  };
  const box = await warmCloudBox({
    client,
    workspaceId: 'workspace-1',
    cloudAgentId: CLOUD_AGENT.id,
    pollMs: 0,
    sleep: async () => {},
  });

  assert.equal(box.status, 'ready');
  assert.equal('relayfileToken' in box, false);
  assert.deepEqual(
    JSON.parse(calls[0].init.body),
    {
      relayfileMountPaths: ['/workspace'],
      workspaceSource: { kind: 'relayfile' },
      requireRelayfileMount: true,
      brokerName: 'herdr-agent-12',
    }
  );
  assert.match(calls[0].path, /\/box\?async=true$/);
  assert.equal(calls[1].init.method, 'GET');
});

test('spawns the Cloud agent in the live mount once, then reuses it', async () => {
  const spawned = [];
  let agents = [];
  let disconnected = 0;
  const createClient = (options) => {
    assert.deepEqual(options, { baseUrl: 'https://sandbox.example', apiKey: 'broker-key' });
    return {
      getSession: async () => ({ mode: 'local' }),
      listAgents: async () => agents,
      spawnCli: async (input) => {
        spawned.push(input);
        agents = [{ name: input.name, current_state: 'idle' }];
      },
      disconnect: () => {
        disconnected += 1;
      },
    };
  };
  const input = {
    box: {
      sandboxId: 'sandbox-1',
      status: 'ready',
      execUrl: 'https://sandbox.example',
      apiKey: 'broker-key',
      relayfileMountPath: '/workspace',
    },
    cloudAgent: CLOUD_AGENT,
    agentName: 'cloud-reviewer',
    task: 'review the live tree',
    channels: ['general'],
    createClient,
  };

  await ensureCloudBrokerAgent(input);
  await ensureCloudBrokerAgent(input);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0], {
    name: 'cloud-reviewer',
    cli: 'claude',
    transport: 'pty',
    cwd: '/workspace',
    model: 'claude-sonnet-4-6',
    task: 'review the live tree',
    channels: ['general'],
  });
  assert.equal(disconnected, 2);
});

test('cloud picker opens the existing fleet-agent pane with credentials only in env', async () => {
  const requests = [];
  const prepared = {
    box: {
      sandboxId: 'sandbox-1',
      status: 'ready',
      execUrl: 'https://sandbox.example',
      apiKey: 'broker-key',
      relayfileMountPath: '/workspace',
    },
    cloudAgent: { id: CLOUD_AGENT.id, harness: 'claude' },
    agent: { name: 'cloud-reviewer', current_state: 'idle' },
    agentName: 'cloud-reviewer',
  };
  const result = await runCloudPicker({
    environment: {
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
      HERDR_PLUGIN_ID: 'agent-relay.herdr-bridge',
      HERDR_RELAY_PROJECT_DIR: '/projects/live-mount',
    },
    prepare: async () => prepared,
    request: async (_socket, method, params) => {
      requests.push({ method, params });
      if (method === 'plugin.pane.open') {
        return { result: { plugin_pane: { pane: { pane_id: 'w1:p2' } } } };
      }
      return { result: { type: 'ok' } };
    },
    logger: { log() {}, warn() {} },
  });

  const open = requests.find((entry) => entry.method === 'plugin.pane.open').params;
  assert.equal(open.entrypoint, 'fleet-agent');
  assert.equal(open.cwd, '/projects/live-mount');
  assert.equal(open.env.RELAY_BROKER_URL, 'https://sandbox.example');
  assert.equal(open.env.RELAY_BROKER_API_KEY, 'broker-key');
  assert.equal(JSON.stringify(open).includes('--api-key'), false);
  assert.deepEqual(result, {
    paneId: 'w1:p2',
    agentName: 'cloud-reviewer',
    sandboxId: 'sandbox-1',
    relayfileMountPath: '/workspace',
  });
});

test('fleet-agent projects remote broker status and attaches without credential argv', async () => {
  const child = new EventEmitter();
  const spawned = [];
  const reports = [];
  await runFleetAgent({
    environment: {
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
      HERDR_PANE_ID: 'w1:p2',
      HERDR_RELAY_AGENT_NAME: 'cloud-reviewer',
      HERDR_RELAY_AGENT_LABEL: 'claude',
      RELAY_BROKER_URL: 'https://sandbox.example',
      RELAY_BROKER_API_KEY: 'broker-key',
    },
    listRemoteAgents: async (connection) => {
      assert.deepEqual(connection, { url: 'https://sandbox.example', apiKey: 'broker-key' });
      return [{ name: 'cloud-reviewer', current_state: 'working' }];
    },
    request: async (_socket, method, params) => {
      reports.push({ method, params });
      return { result: { type: 'ok' } };
    },
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args, options });
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    },
    pollIntervalMs: 60_000,
  });

  assert.equal(spawned[0].command, 'agent-relay');
  assert.deepEqual(spawned[0].args, [
    'node',
    'agent',
    'attach',
    'cloud-reviewer',
    '--mode',
    'drive',
  ]);
  assert.equal(spawned[0].args.includes('broker-key'), false);
  assert.equal(spawned[0].options.env.RELAY_BROKER_API_KEY, 'broker-key');
  assert.equal(reports[0].params.source, 'cloud-sandbox');
  assert.equal(reports[0].params.state, 'working');
});

test('manifest exposes a Cloud picker on the same platforms as fleet panes', async () => {
  const manifest = await readFile(join(process.cwd(), 'herdr-plugin.toml'), 'utf8');
  assert.match(manifest, /id = "cloud"/);
  assert.match(manifest, /command = \["node", "dist\/cloud-picker\.mjs"\]/);
  assert.match(manifest, /id = "cloud"[\s\S]*?platforms = \["linux", "macos"\]/);
});
