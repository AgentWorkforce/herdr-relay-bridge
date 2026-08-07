import assert from 'node:assert/strict';
import test from 'node:test';

import { BrokerUnavailableError, spawnCommand } from '../dist/fleet.mjs';
import { runFleetAgent } from '../dist/fleet-agent.mjs';
import {
  DEFAULT_NODE_CAPABILITIES,
  buildNodeDefinition,
  capabilityCli,
  createPaneSpawnHandler,
  herdrProviderName,
  parseCapabilities,
  readBrokerConnection,
  readNodeIdentity,
  runFleetNode,
} from '../dist/fleet-node.mjs';

const SESSION = {
  node_id: 'node_5b46ac5e',
  node_name: 'chief-broker',
  node_token: 'nt-test-fixture-token',
};

const okFetch = (body = SESSION) => async () => ({ ok: true, json: async () => body });

const SESSION_IDENTITY = {
  nodeId: 'node_5b46ac5e',
  nodeName: 'chief-broker',
  nodeToken: 'nt-test-fixture-token',
};

function paneResponse(paneId = 'pane-1') {
  return { result: { plugin_pane: { pane: { pane_id: paneId } } } };
}

test('serves the capability names the fleet already advertises, not a Herdr-specific one', () => {
  assert.deepEqual(DEFAULT_NODE_CAPABILITIES, ['spawn:claude', 'spawn:codex']);
  assert.deepEqual(parseCapabilities(undefined), ['spawn:claude', 'spawn:codex']);
  assert.deepEqual(parseCapabilities('  '), ['spawn:claude', 'spawn:codex']);
  assert.deepEqual(parseCapabilities('spawn:claude, spawn:gemini'), ['spawn:claude', 'spawn:gemini']);
});

test('rejects a capability that names no CLI instead of serving an unroutable name', () => {
  assert.equal(capabilityCli('spawn:claude'), 'claude');
  assert.throws(() => capabilityCli('workflow:run'), /must be spawn:<cli>/);
  assert.throws(() => capabilityCli('spawn:'), /names no CLI/);
  assert.throws(() => parseCapabilities('spawn:claude,release'), /must be spawn:<cli>/);
});

test('derives a provider name distinct from the broker provider', () => {
  assert.equal(herdrProviderName('Khaliqs-MacBook-Pro.local'), 'herdr-khaliqs-macbook-pro');
  assert.equal(herdrProviderName('build box 2'), 'herdr-build-box-2');
  assert.equal(herdrProviderName('...'), 'herdr-host');
});

test('a missing broker connection file reports the recovery path, not a raw ENOENT', async () => {
  await assert.rejects(
    readBrokerConnection('/projects/chief', {
      read: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    }),
    (error) => {
      assert.ok(error instanceof BrokerUnavailableError);
      assert.match(error.message, /agent-relay node up/);
      assert.match(error.message, /\/projects\/chief/);
      return true;
    }
  );
});

test('a malformed or incomplete connection file names the file rather than failing obscurely', async () => {
  await assert.rejects(
    readBrokerConnection('/projects/chief', { read: async () => 'not json' }),
    /connection\.json is not valid JSON/
  );
  await assert.rejects(
    readBrokerConnection('/projects/chief', { read: async () => JSON.stringify({ url: 'http://x' }) }),
    /names no broker url and key/
  );
});

test('reads the node identity the broker registered as', async () => {
  const calls = [];
  const identity = await readNodeIdentity(
    { url: 'http://127.0.0.1:54611', apiKey: 'br_key' },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, json: async () => SESSION };
      },
    }
  );
  assert.deepEqual(identity, {
    nodeId: 'node_5b46ac5e',
    nodeName: 'chief-broker',
    nodeToken: 'nt-test-fixture-token',
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:54611/api/session');
  assert.equal(calls[0].init.headers.authorization, 'Bearer br_key');
});

test('a broker with no node token fails closed with the fix, rather than serving nothing', async () => {
  await assert.rejects(
    readNodeIdentity({ url: 'http://x', apiKey: 'k' }, { fetchImpl: okFetch({ ...SESSION, node_token: '' }) }),
    /RELAY_NODE_TOKEN/
  );
  await assert.rejects(
    readNodeIdentity({ url: 'http://x', apiKey: 'k' }, { fetchImpl: okFetch({ node_token: 'nt' }) }),
    /has not registered a fleet node yet/
  );
  await assert.rejects(
    readNodeIdentity({ url: 'http://x', apiKey: 'k' }, { fetchImpl: async () => ({ ok: false, status: 401 }) }),
    /refused the node identity request \(HTTP 401\)/
  );
});

test('a placement opens a visible Herdr pane that spawns the requested agent', async () => {
  const requests = [];
  const handler = createPaneSpawnHandler({
    socketPath: '/tmp/herdr.sock',
    pluginId: 'agent-relay.herdr-bridge',
    projectDir: '/projects/chief',
    mode: 'drive',
    logger: { log() {} },
    request: async (socketPath, method, params) => {
      requests.push({ method, params });
      return method === 'plugin.pane.open' ? paneResponse('pane-7') : {};
    },
  });

  const result = await handler({ name: 'scout', task: 'survey the repo' }, 'spawn:claude');

  const open = requests.find((entry) => entry.method === 'plugin.pane.open');
  assert.equal(open.params.entrypoint, 'fleet-agent', 'reuses the T3 pane entrypoint');
  assert.equal(open.params.placement, 'tab');
  assert.equal(open.params.focus, true);
  assert.equal(open.params.cwd, '/projects/chief');
  assert.equal(
    'workspace_id' in open.params,
    false,
    'omits workspace_id so the pane lands in the focused workspace'
  );
  assert.equal(open.params.env.HERDR_RELAY_SPAWN_CLI, 'claude', 'capability selects the CLI');
  assert.equal(open.params.env.HERDR_RELAY_AGENT_NAME, 'scout');
  assert.equal(open.params.env.HERDR_RELAY_SPAWN_TASK, 'survey the repo');
  assert.equal(open.params.env.HERDR_RELAY_ATTACH_MODE, 'drive');

  assert.deepEqual(
    requests.find((entry) => entry.method === 'pane.rename').params,
    { pane_id: 'pane-7', label: 'scout' }
  );
  assert.equal(
    requests.some((entry) => entry.method === 'pane.report_agent'),
    false,
    'leaves pane.report_agent to the pane projector so one writer owns the state'
  );
  assert.deepEqual(result, {
    agent: 'scout',
    cli: 'claude',
    capability: 'spawn:claude',
    pane_id: 'pane-7',
    cwd: '/projects/chief',
    surface: 'herdr-pane',
  });
});

test('an explicit cli and cwd in the placement input win over the capability default', async () => {
  const requests = [];
  const handler = createPaneSpawnHandler({
    socketPath: '/tmp/herdr.sock',
    pluginId: 'p',
    projectDir: '/projects/chief',
    mode: 'view',
    logger: { log() {} },
    request: async (_socket, method, params) => {
      requests.push({ method, params });
      return paneResponse();
    },
  });
  const result = await handler(
    { agent: 'probe', cli: 'codex', cwd: '/projects/relay', channels: ['general', 'fleet'] },
    'spawn:claude'
  );
  const open = requests[0].params;
  assert.equal(open.env.HERDR_RELAY_SPAWN_CLI, 'codex');
  assert.equal(open.cwd, '/projects/relay');
  assert.equal(open.env.HERDR_RELAY_SPAWN_CHANNELS, 'general,fleet');
  assert.equal(result.agent, 'probe');
});

test('a failed pane open surfaces the Herdr failure instead of reporting a phantom spawn', async () => {
  const handler = createPaneSpawnHandler({
    socketPath: '/tmp/herdr.sock',
    pluginId: 'p',
    projectDir: '/projects/chief',
    mode: 'drive',
    logger: { log() {} },
    request: async () => ({ result: {} }),
  });
  await assert.rejects(handler({ name: 'scout' }, 'spawn:claude'), /did not return the opened fleet pane/);
});

test('the node definition declares each capability and routes it to its own CLI', async () => {
  const seen = [];
  const definition = buildNodeDefinition({
    providerName: 'herdr-host',
    capabilities: ['spawn:claude', 'spawn:codex'],
    handler: async (input, capability) => {
      seen.push({ input, capability });
      return { ok: true };
    },
  });
  assert.deepEqual(Object.keys(definition.capabilities), ['spawn:claude', 'spawn:codex']);
  assert.equal(
    definition.tags,
    undefined,
    'sets no tags: a node tag outlives the provider and would advertise a pane that has closed'
  );
  assert.equal(definition.capabilities['spawn:codex'].metadata.cli, 'codex');
  assert.equal(definition.capabilities['spawn:codex'].metadata.surface, 'herdr-pane');

  await definition.capabilities['spawn:codex'].handler({ name: 'scout' }, {});
  assert.deepEqual(seen, [{ input: { name: 'scout' }, capability: 'spawn:codex' }]);
});

test('a placement missing an agent name is rejected by the declared schema', () => {
  const definition = buildNodeDefinition({
    providerName: 'herdr-host',
    capabilities: ['spawn:claude'],
    handler: async () => ({}),
  });
  const parsed = definition.capabilities['spawn:claude'].input.safeParse({ task: 'go' });
  assert.equal(parsed.success, false);
});

test('serving never renames the live node it attaches to', async () => {
  const served = [];
  await runFleetNode({
    environment: {
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
      HERDR_PLUGIN_ID: 'agent-relay.herdr-bridge',
      HERDR_RELAY_PROJECT_DIR: '/projects/chief',
    },
    readConnection: async () => ({ url: 'http://127.0.0.1:1', apiKey: 'br_key' }),
    readIdentity: async () => SESSION_IDENTITY,
    serve: async (options) => {
      served.push(options);
    },
    logger: { log() {}, error() {} },
  });

  const [options] = served;
  assert.equal(
    options.nameOverride,
    'chief-broker',
    'the node keeps the broker name; a rename would steal the node from its agents'
  );
  assert.equal(options.providerName, herdrProviderName());
  assert.notEqual(options.providerName, options.nameOverride, 'attaches as a second provider');
  assert.equal(options.connection.nodeId, 'node_5b46ac5e');
  assert.equal(options.connection.nodeToken, 'nt-test-fixture-token');
  assert.deepEqual(Object.keys(options.definition.capabilities), ['spawn:claude', 'spawn:codex']);
});

test('the node pane refuses to serve without the Herdr context it needs', async () => {
  await assert.rejects(
    runFleetNode({ environment: {}, logger: { log() {}, error() {} } }),
    /HERDR_SOCKET_PATH/
  );
  await assert.rejects(
    runFleetNode({ environment: { HERDR_SOCKET_PATH: '/s' }, logger: { log() {}, error() {} } }),
    /HERDR_PLUGIN_ID/
  );
});

test('spawn panes create the agent through the broker with channels last', () => {
  assert.deepEqual(
    spawnCommand({ cli: 'claude', agentName: 'scout', mode: 'drive', task: 'go', model: 'opus' }),
    {
      command: 'agent-relay',
      args: [
        'node', 'agent', 'new', 'claude',
        '--name', 'scout',
        '--mode', 'drive',
        '--task', 'go',
        '--model', 'opus',
      ],
    }
  );
  const withChannels = spawnCommand({
    cli: 'codex',
    agentName: 'probe',
    mode: 'view',
    channels: ['general', 'fleet'],
  });
  assert.deepEqual(withChannels.args.slice(-3), ['--channels', 'general', 'fleet']);
  assert.throws(() => spawnCommand({ cli: '', agentName: 'x', mode: 'drive' }), /requires a CLI provider/);
  assert.throws(() => spawnCommand({ cli: 'claude', agentName: ' ', mode: 'drive' }), /requires an agent name/);
});

test('a pane told to spawn runs node agent new; without it the pane still attaches', async () => {
  const runs = [];
  const spawnProcess = (command, args) => {
    runs.push({ command, args });
    const child = { once: (event, cb) => event === 'exit' && queueMicrotask(() => cb(0, null)) };
    return child;
  };
  const base = {
    listAgents: async () => [{ name: 'scout', current_state: 'working' }],
    request: async () => ({}),
    spawnProcess,
    pollIntervalMs: 60_000,
  };

  await runFleetAgent({
    ...base,
    environment: {
      HERDR_SOCKET_PATH: '/s',
      HERDR_PANE_ID: 'pane-1',
      HERDR_RELAY_AGENT_NAME: 'scout',
      HERDR_RELAY_SPAWN_CLI: 'claude',
      HERDR_RELAY_SPAWN_TASK: 'go',
    },
  });
  assert.deepEqual(runs[0].args.slice(0, 5), ['node', 'agent', 'new', 'claude', '--name']);

  await runFleetAgent({
    ...base,
    environment: {
      HERDR_SOCKET_PATH: '/s',
      HERDR_PANE_ID: 'pane-1',
      HERDR_RELAY_AGENT_NAME: 'scout',
    },
  });
  assert.deepEqual(runs[1].args, ['node', 'agent', 'attach', 'scout', '--mode', 'drive']);
});
