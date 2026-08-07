import assert from 'node:assert/strict';
import test from 'node:test';

import { BrokerUnavailableError, installStopHandlers, spawnCommand } from '../dist/fleet.mjs';
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
  waitForBrokerAgent,
  agentIdentity,
} from '../dist/fleet-node.mjs';

const SESSION = {
  node_id: 'node_5b46ac5e',
  node_name: 'broker-node',
  node_token: 'test-node-token',
};

const okFetch = (body = SESSION) => async () => ({ ok: true, json: async () => body });

const SESSION_IDENTITY = {
  nodeId: 'node_5b46ac5e',
  nodeName: 'broker-node',
  nodeToken: 'test-node-token',
};

function paneResponse(paneId = 'pane-1') {
  return { result: { plugin_pane: { pane: { pane_id: paneId } } } };
}

/**
 * Models a real spawn: the broker does not hold the agent when the placement
 * arrives, and holds it once the pane has run `node agent new`. The first call
 * is the pre-spawn snapshot, so it must be empty — an agent already present
 * would be a name collision, not a spawn.
 */
function agentAppearsAfterSpawn(name, { sessionId = 'session-new', onList } = {}) {
  let calls = 0;
  return async (dir) => {
    onList?.(dir);
    return calls++ === 0 ? [] : [{ name, sessionId, current_state: 'working' }];
  };
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
  assert.equal(herdrProviderName('Local-Host-01.local'), 'herdr-local-host-01');
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
    { url: 'http://127.0.0.1:54611', apiKey: 'test-api-key' },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, json: async () => SESSION };
      },
    }
  );
  assert.deepEqual(identity, {
    nodeId: 'node_5b46ac5e',
    nodeName: 'broker-node',
    nodeToken: 'test-node-token',
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:54611/api/session');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-api-key');
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
    logger: { log() {}, warn() {} },
    listAgents: agentAppearsAfterSpawn('scout'),
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
    projectDir: '/projects/chief',
    surface: 'herdr-pane',
  });
});

test('an explicit cli in the placement input wins over the capability default', async () => {
  const requests = [];
  const handler = createPaneSpawnHandler({
    socketPath: '/tmp/herdr.sock',
    pluginId: 'p',
    projectDir: '/projects/chief',
    mode: 'view',
    logger: { log() {}, warn() {} },
    listAgents: agentAppearsAfterSpawn('probe'),
    request: async (_socket, method, params) => {
      requests.push({ method, params });
      return paneResponse();
    },
  });
  const result = await handler(
    { agent: 'probe', cli: 'codex', channels: ['general', 'fleet'] },
    'spawn:claude'
  );
  const open = requests[0].params;
  assert.equal(open.env.HERDR_RELAY_SPAWN_CLI, 'codex');
  assert.equal(open.env.HERDR_RELAY_SPAWN_CHANNELS, 'general,fleet');
  assert.equal(result.agent, 'probe');
});

// --- PR #2 review remediation -------------------------------------------------
// These three assert the defects codex/cubic found. Each was verified RED against
// the pre-fix implementation before the fix landed.

test('a placement is not acknowledged until the broker has actually created the agent', async () => {
  const methods = [];
  const handler = createPaneSpawnHandler({
    socketPath: '/tmp/herdr.sock',
    pluginId: 'p',
    projectDir: '/projects/chief',
    mode: 'drive',
    logger: { log() {}, warn() {} },
    // The pane opens, but `agent-relay node agent new` never succeeds, so the
    // agent never appears on the broker.
    listAgents: async () => [],
    creationTimeoutMs: 60,
    creationPollMs: 10,
    request: async (_socket, method) => {
      methods.push(method);
      return method === 'plugin.pane.open' ? paneResponse('pane-9') : {};
    },
  });

  await assert.rejects(
    handler({ name: 'ghost' }, 'spawn:claude'),
    /ghost.*never appeared on the broker/,
    'a placement whose agent was never created must not resolve as a spawned agent'
  );
  assert.equal(
    methods.includes('pane.close'),
    true,
    'closes the pane it opened rather than leaving an orphan behind'
  );
});

test('broker operations stay pinned to the registered project when a placement asks for another cwd', async () => {
  const opened = [];
  const polled = [];
  const handler = createPaneSpawnHandler({
    socketPath: '/tmp/herdr.sock',
    pluginId: 'p',
    projectDir: '/projects/chief',
    mode: 'drive',
    logger: { log() {}, warn() {} },
    listAgents: agentAppearsAfterSpawn('probe', { onList: (dir) => polled.push(dir) }),
    request: async (_socket, method, params) => {
      if (method === 'plugin.pane.open') {
        opened.push(params);
        return paneResponse('pane-3');
      }
      return {};
    },
  });

  const result = await handler({ name: 'probe', cwd: '/projects/relay' }, 'spawn:claude');

  assert.equal(
    opened[0].cwd,
    '/projects/chief',
    'the pane runs in the project whose broker registered this provider, not the requested cwd'
  );
  assert.equal(
    opened[0].env.HERDR_RELAY_SPAWN_CWD,
    '/projects/relay',
    'the requested working directory travels separately, for the agent rather than for broker discovery'
  );
  assert.deepEqual(
    [...new Set(polled)],
    ['/projects/chief'],
    'the broker is only ever polled in the registered project'
  );
  assert.equal(result.cwd, '/projects/relay', 'reports where the agent works');
  assert.equal(result.projectDir, '/projects/chief', 'reports which broker owns it');
});

test('a cosmetic rename failure does not fail a placement whose pane already opened', async () => {
  const methods = [];
  const warnings = [];
  const handler = createPaneSpawnHandler({
    socketPath: '/tmp/herdr.sock',
    pluginId: 'p',
    projectDir: '/projects/chief',
    mode: 'drive',
    logger: { log() {}, warn: (message) => warnings.push(message) },
    listAgents: agentAppearsAfterSpawn('scout'),
    request: async (_socket, method) => {
      methods.push(method);
      if (method === 'pane.rename') throw new Error('Herdr API request failed');
      return method === 'plugin.pane.open' ? paneResponse('pane-5') : {};
    },
  });

  const result = await handler({ name: 'scout' }, 'spawn:claude');

  assert.equal(result.pane_id, 'pane-5', 'the placement still succeeds; the pane is creating the agent');
  assert.equal(
    methods.includes('pane.close'),
    false,
    'never tears down a pane that is already creating the agent over a cosmetic label'
  );
  assert.equal(warnings.length, 1, 'the rename failure is surfaced as a warning rather than swallowed');
});

test('a failed pane open surfaces the Herdr failure instead of reporting a phantom spawn', async () => {
  const handler = createPaneSpawnHandler({
    socketPath: '/tmp/herdr.sock',
    pluginId: 'p',
    projectDir: '/projects/chief',
    mode: 'drive',
    logger: { log() {}, warn() {} },
    listAgents: async () => [],
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
    readConnection: async () => ({ url: 'http://127.0.0.1:1', apiKey: 'test-api-key' }),
    readIdentity: async () => SESSION_IDENTITY,
    serve: async (options) => {
      served.push(options);
    },
    logger: { log() {}, error() {} },
  });

  const [options] = served;
  assert.equal(
    options.nameOverride,
    'broker-node',
    'the node keeps the broker name; a rename would steal the node from its agents'
  );
  assert.equal(options.providerName, herdrProviderName());
  assert.notEqual(options.providerName, options.nameOverride, 'attaches as a second provider');
  assert.equal(options.connection.nodeId, 'node_5b46ac5e');
  assert.equal(options.connection.nodeToken, 'test-node-token');
  assert.deepEqual(Object.keys(options.definition.capabilities), ['spawn:claude', 'spawn:codex']);
});

// --- exact-head review: attributable creation, not mere presence --------------
// Waiting for "an agent with this name" is not the same as waiting for "the agent
// this placement created". If the name already exists, `node agent new` fails
// precisely BECAUSE it is taken — and a presence check then reports success for
// an agent the placement did not create, and may not even own.

test('a pre-existing agent of the same name is refused before any pane is opened', async () => {
  const methods = [];
  const handler = createPaneSpawnHandler({
    socketPath: '/tmp/herdr.sock',
    pluginId: 'p',
    projectDir: '/projects/chief',
    mode: 'drive',
    logger: { log() {}, warn() {} },
    listAgents: async () => [{ name: 'scout', sessionId: 'session-already-here' }],
    creationTimeoutMs: 60,
    creationPollMs: 10,
    request: async (_socket, method) => {
      methods.push(method);
      return method === 'plugin.pane.open' ? paneResponse('pane-x') : {};
    },
  });

  await assert.rejects(
    handler({ name: 'scout' }, 'spawn:claude'),
    /already (running|exists)/i,
    'a name collision must fail fast and readably, not be reported as a spawn'
  );
  assert.equal(
    methods.includes('plugin.pane.open'),
    false,
    'refuses BEFORE opening a pane: a collision must not leave a stray pane behind'
  );
});

test('a colliding placement never acknowledges a herdr-pane surface', async () => {
  const handler = createPaneSpawnHandler({
    socketPath: '/tmp/herdr.sock',
    pluginId: 'p',
    projectDir: '/projects/chief',
    mode: 'drive',
    logger: { log() {}, warn() {} },
    listAgents: async () => [{ name: 'scout', sessionId: 's1' }],
    creationTimeoutMs: 60,
    creationPollMs: 10,
    request: async (_socket, method) => (method === 'plugin.pane.open' ? paneResponse() : {}),
  });

  let acknowledged;
  try {
    acknowledged = await handler({ name: 'scout' }, 'spawn:claude');
  } catch {
    acknowledged = undefined;
  }
  assert.equal(
    acknowledged?.surface,
    undefined,
    'a pre-existing name must never resolve as surface=herdr-pane'
  );
});

test('a same-name placement already in flight is refused before a second pane opens', async () => {
  const methods = [];
  let listCalls = 0;
  const handler = createPaneSpawnHandler({
    socketPath: '/tmp/herdr.sock',
    pluginId: 'p',
    projectDir: '/projects/chief',
    mode: 'drive',
    logger: { log() {}, warn() {} },
    listAgents: async () => {
      listCalls += 1;
      return listCalls === 1 ? [] : [{ name: 'scout', sessionId: 'created-by-first-placement' }];
    },
    request: async (_socket, method) => {
      methods.push(method);
      return method === 'plugin.pane.open' ? paneResponse('pane-first') : {};
    },
  });

  const first = handler({ name: 'scout' }, 'spawn:claude');
  await assert.rejects(
    handler({ name: 'scout' }, 'spawn:claude'),
    /already being created/,
    'the second placement must not treat the first placement\'s broker record as its own'
  );
  await first;
  assert.equal(
    methods.filter((method) => method === 'plugin.pane.open').length,
    1,
    'only the first placement may open a pane for the in-flight name'
  );
});

test('wait rejects a record from the pre-spawn snapshot', async () => {
  // The same record is returned forever. Its identity was already known, so it is
  // not evidence that this placement created anything.
  await assert.rejects(
    waitForBrokerAgent({
      agentName: 'scout',
      projectDir: '/projects/chief',
      listAgents: async () => [{ name: 'scout', sessionId: 'seen-before' }],
      knownIdentities: new Set(['session:seen-before']),
      timeoutMs: 50,
      pollMs: 10,
    }),
    /never appeared on the broker/,
    'a record present in the pre-spawn snapshot must not satisfy the wait'
  );

});

test('a final broker recheck preserves an agent that becomes visible at the timeout boundary', async () => {
  let listCalls = 0;
  let clockCalls = 0;
  const found = await waitForBrokerAgent({
    agentName: 'scout',
    projectDir: '/projects/chief',
    knownIdentities: new Set(),
    timeoutMs: 50,
    pollMs: 10,
    now: () => (clockCalls++ === 0 ? 0 : 50),
    listAgents: async () => {
      listCalls += 1;
      return listCalls === 1 ? [] : [{ name: 'scout', sessionId: 'created-at-boundary' }];
    },
  });

  assert.equal(found, true, 'the final visibility check preserves the newly created agent');
  assert.equal(listCalls, 2, 'checks once more before the handler can close the pane');
});

test('agent identity prefers the stable sessionId over the name', () => {
  assert.equal(agentIdentity({ name: 'scout', sessionId: 'abc' }), 'session:abc');
  assert.equal(agentIdentity({ name: 'scout' }), 'name:scout');
});

// --- provider lifecycle: teardown must reach the control plane ----------------
// A provider registration is control-plane state that outlives this process.
// Killing the pane strands it, and every later placement for its capabilities is
// answered "Provider ... is offline" until someone deregisters it. This happened
// in production: the local process WAS gone and the registration was still live,
// so process absence is exactly the wrong thing to assert on.

// WHY THESE FAKES ARE ONLY A PROXY, and what makes the proxy sound.
//
// These tests cannot observe the `node.deregister` websocket frame — the fake
// stands in for NodeProviderClient and no socket exists. What they DO assert is
// the one thing this module controls: that Herdr's shutdown signals abort the
// serve loop, and that runFleetNode does not resolve until serve settles.
//
// That is only meaningful because of a specific ordering inside the pinned
// @agent-relay/fleet@11.4.2 → @relaycast/sdk stack. In `stop()`
// (node-provider.js), the frame is sent at line 144 and `settleServe()` runs at
// line 154 — deregister strictly precedes settlement, and serveNode's promise
// settles via settleServe. So "serve has settled" implies "the frame was already
// enqueued", and not exiting before serve settles is what prevents the process
// from dying mid-flush. The fleet dependency is pinned exactly (11.4.2) because
// that ordering is the evidence; a version that settled before sending would
// invalidate these tests without failing them.
//
// The ordering is necessary but NOT sufficient: line 144 is gated on
// `ws.readyState === 1 && this.registered && this.instanceId`, so a socket that
// already dropped sends no frame while `stop()` still settles. That gap is
// unobservable from here, which is exactly why the code must not log a claim of
// deregistration — see the assertion below.

function stopHandlerHarness() {
  const handlers = new Map();
  return {
    target: { platform: 'darwin', once: (event, fn) => handlers.set(event, fn) },
    raise: (event) => handlers.get(event)?.(),
    events: () => [...handlers.keys()].sort(),
  };
}

test('Herdr shutdown signals reach the serve loop so the provider can deregister', async () => {
  const harness = stopHandlerHarness();
  let served;
  const run = runFleetNode({
    environment: {
      HERDR_SOCKET_PATH: '/s',
      HERDR_PLUGIN_ID: 'p',
      HERDR_RELAY_PROJECT_DIR: '/projects/chief',
    },
    readConnection: async () => ({ url: 'http://127.0.0.1:1', apiKey: 'k' }),
    readIdentity: async () => SESSION_IDENTITY,
    installHandlers: (target, stop) => installStopHandlers(target, stop),
    stopTarget: harness.target,
    logger: { log() {}, error() {} },
    serve: (options) =>
      new Promise((resolve) => {
        served = options;
        // Stand in for the SDK: settle only once the signal aborts, which is
        // when NodeProviderClient.stop() sends its `node.deregister` frame.
        options.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    harness.events(),
    ['SIGHUP', 'SIGINT', 'SIGTERM'],
    'a pane closed by any of Herdr\'s shutdown signals must still deregister'
  );
  assert.ok(served.signal, 'serve is given a signal it can stop on');
  assert.equal(served.signal.aborted, false, 'still serving before shutdown');

  harness.raise('SIGHUP');
  await run;
  assert.equal(served.signal.aborted, true, 'the shutdown signal aborted the serve loop');
});

test('the node pane does not exit until the deregister has flushed', async () => {
  const harness = stopHandlerHarness();
  let deregistered = false;
  let resolved = false;

  const run = runFleetNode({
    environment: {
      HERDR_SOCKET_PATH: '/s',
      HERDR_PLUGIN_ID: 'p',
      HERDR_RELAY_PROJECT_DIR: '/projects/chief',
    },
    readConnection: async () => ({ url: 'http://127.0.0.1:1', apiKey: 'k' }),
    readIdentity: async () => SESSION_IDENTITY,
    installHandlers: (target, stop) => installStopHandlers(target, stop),
    stopTarget: harness.target,
    logger: { log() {}, error() {} },
    serve: (options) =>
      new Promise((resolve) => {
        options.signal.addEventListener(
          'abort',
          () => {
            // The real client drains in-flight invokes, then sends the frame.
            setTimeout(() => {
              deregistered = true;
              resolve();
            }, 20);
          },
          { once: true }
        );
      }),
  }).then(() => {
    resolved = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  harness.raise('SIGTERM');
  assert.equal(resolved, false, 'must not resolve the instant the signal arrives');
  await run;

  // The load-bearing assertion. Resolving before the frame flushes lets the
  // process exit with the registration still live on the node — which reads as a
  // clean teardown locally and strands every future placement.
  assert.equal(
    deregistered,
    true,
    'returned before the provider was deregistered: the process would exit leaving the registration live'
  );
  assert.equal(resolved, true);
});

test('shutdown never claims a deregistration it cannot prove', async () => {
  const harness = stopHandlerHarness();
  const logs = [];

  // Models the dropped-socket path: stop() settles, but the gate at
  // node-provider.js:143 means no `node.deregister` frame was ever sent. From
  // here that is indistinguishable from a clean deregister — so the log must not
  // assert one.
  const run = runFleetNode({
    environment: {
      HERDR_SOCKET_PATH: '/s',
      HERDR_PLUGIN_ID: 'p',
      HERDR_RELAY_PROJECT_DIR: '/projects/chief',
    },
    readConnection: async () => ({ url: 'http://127.0.0.1:1', apiKey: 'k' }),
    readIdentity: async () => SESSION_IDENTITY,
    installHandlers: (target, stop) => installStopHandlers(target, stop),
    stopTarget: harness.target,
    logger: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    serve: (options) =>
      new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  harness.raise('SIGTERM');
  await run;

  const claims = logs.filter((line) => /deregister/i.test(line));
  assert.deepEqual(
    claims,
    [],
    `logged a deregistration it cannot observe: ${JSON.stringify(claims)}`
  );
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
