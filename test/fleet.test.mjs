import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  BrokerUnavailableError,
  attachCommand,
  createStatusProjector,
  fleetProjectDir,
  listBrokerAgents,
  parseAgentList,
  projectBrokerState,
} from '../dist/fleet.mjs';
import { runFleetAgent } from '../dist/fleet-agent.mjs';
import { main as fleetPickerMain, runFleetPicker } from '../dist/fleet-picker.mjs';

test('maps authoritative broker states to Herdr states without emitting done', () => {
  assert.equal(projectBrokerState('idle'), 'idle');
  assert.equal(projectBrokerState('working'), 'working');
  assert.equal(projectBrokerState('blocked_on_send'), 'blocked');
  assert.equal(projectBrokerState('blocked'), 'blocked');
  assert.equal(projectBrokerState('done'), 'unknown');
  assert.equal(projectBrokerState('hibernating'), 'unknown');
  assert.equal(projectBrokerState(undefined), 'unknown');
});

test('lists agents project-scoped and replaces raw broker-down errors with a readable failure', async () => {
  const calls = [];
  const agents = await listBrokerAgents('/projects/chief', {
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({ agents: [{ name: 'chief', current_state: 'working' }] }),
      };
    },
  });
  assert.deepEqual(agents.map((agent) => agent.name), ['chief']);
  assert.deepEqual(calls, [
    {
      command: 'agent-relay',
      args: ['node', 'agent', 'list'],
      options: { cwd: '/projects/chief' },
    },
  ]);

  await assert.rejects(
    listBrokerAgents('/projects/chief', {
      run: async () => {
        throw new Error('could not locate broker connection');
      },
    }),
    (error) => {
      assert.ok(error instanceof BrokerUnavailableError);
      assert.match(error.message, /broker is unavailable for \/projects\/chief/);
      assert.match(error.message, /agent-relay node up/);
      assert.doesNotMatch(error.message, /could not locate broker connection/);
      return true;
    }
  );
});

test('fleet picker failure waits for dismissal when its pane is interactive', async () => {
  // Injecting the dismissal keeps this assertion non-interactive while proving
  // main does not immediately erase a readable failure pane.
  let dismissed = false;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  console.error = () => {};
  try {
    await fleetPickerMain({
      dismiss: async () => {
        dismissed = true;
      },
    });
    assert.equal(dismissed, true);
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
});

test('accepts both broker agent-list JSON envelopes and rejects malformed output', () => {
  assert.deepEqual(parseAgentList('[{"name":"one"}]').map((agent) => agent.name), ['one']);
  assert.deepEqual(
    parseAgentList('{"agents":[{"name":"two"}]}').map((agent) => agent.name),
    ['two']
  );
  assert.throws(() => parseAgentList('{broken'), /invalid agent list/);
  assert.throws(() => parseAgentList('{}'), /invalid agent list/);
});

test('fleet picker opens exactly one Chief-cwd attach pane per live broker agent', async () => {
  const requests = [];
  let paneSequence = 0;
  const request = async (socketPath, method, params) => {
    requests.push({ socketPath, method, params });
    if (method === 'workspace.create') {
      return {
        result: {
          workspace: { workspace_id: 'w9' },
          root_pane: { pane_id: 'w9:p1' },
        },
      };
    }
    if (method === 'plugin.pane.open') {
      paneSequence += 1;
      return { result: { plugin_pane: { pane: { pane_id: `w9:p${paneSequence + 1}` } } } };
    }
    return { result: { type: 'ok' } };
  };
  const environment = {
    HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    HERDR_PLUGIN_ID: 'agent-relay.herdr-bridge',
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_cwd: '/projects/chief',
      focused_pane_cwd: '/projects/chief',
    }),
  };
  const agents = [
    { name: 'chief-khaliq', cli: 'claude', current_state: 'working', runtime: 'pty' },
    { name: 'worker', cli: 'codex', current_state: 'blocked_on_send', runtime: 'pty' },
    { name: 'reviewer', cli: 'claude', current_state: 'idle', runtime: 'pty' },
  ];

  const result = await runFleetPicker({
    environment,
    listAgents: async (projectDir) => {
      assert.equal(projectDir, '/projects/chief');
      return agents;
    },
    findChief: async () => 'chief-khaliq',
    request,
    logger: { log() {} },
  });

  assert.equal(result.workspaceId, 'w9');
  assert.equal(result.panes.length, agents.length);
  const opens = requests.filter((requestRecord) => requestRecord.method === 'plugin.pane.open');
  assert.equal(opens.length, agents.length);
  for (const open of opens) {
    assert.equal(open.params.workspace_id, 'w9');
    assert.equal(open.params.cwd, '/projects/chief');
    assert.equal(open.params.placement, 'tab');
    assert.equal(open.params.entrypoint, 'fleet-agent');
  }
  assert.equal(opens[0].params.env.HERDR_RELAY_RESIDENT_CHIEF, '1');
  assert.equal(opens[1].params.env.HERDR_RELAY_RESIDENT_CHIEF, '0');

  const reports = requests.filter((requestRecord) => requestRecord.method === 'pane.report_agent');
  assert.deepEqual(reports.map((report) => report.params.state), ['working', 'blocked', 'idle']);
  assert.ok(reports.every((report) => report.params.source === 'fleet-picker'));
  assert.ok(reports.every((report) => !('done' === report.params.state)));
  assert.deepEqual(
    requests.find((requestRecord) => requestRecord.method === 'pane.close')?.params,
    { pane_id: 'w9:p1' }
  );
  assert.deepEqual(
    requests.find((requestRecord) => requestRecord.method === 'workspace.focus')?.params,
    { workspace_id: 'w9' }
  );
});

test('status polling reports the initial projection once and then only broker changes', async () => {
  const snapshots = [
    [{ name: 'worker', current_state: 'working' }],
    [{ name: 'worker', current_state: 'blocked_on_send' }],
    [{ name: 'worker', current_state: 'blocked_on_send' }],
    [{ name: 'worker', current_state: 'done' }],
    [{ name: 'worker', current_state: 'done' }],
  ];
  const reports = [];
  const projector = createStatusProjector({
    agentName: 'worker',
    initialBrokerState: 'working',
    loadAgents: async () => snapshots.shift(),
    report: async (report) => reports.push(report),
  });

  assert.equal(await projector.poll(), false);
  assert.equal(await projector.poll(), true);
  assert.equal(await projector.poll(), false);
  assert.equal(await projector.poll(), true);
  assert.equal(await projector.poll(), false);
  assert.deepEqual(reports.map((report) => report.state), ['blocked', 'unknown']);
});

test('a failed status report is retried instead of suppressing the broker change', async () => {
  let attempts = 0;
  const projector = createStatusProjector({
    agentName: 'worker',
    initialBrokerState: 'idle',
    loadAgents: async () => [{ name: 'worker', current_state: 'working' }],
    report: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Herdr restarting');
    },
  });
  await assert.rejects(projector.poll(), /Herdr restarting/);
  assert.equal(await projector.poll(), true);
  assert.equal(attempts, 2);
});

test('fleet panes attach through agent-relay while the resident Chief uses chief.sh', () => {
  assert.deepEqual(
    attachCommand({ agentName: 'worker', mode: 'view' }),
    {
      command: 'agent-relay',
      args: ['node', 'agent', 'attach', 'worker', '--mode', 'view'],
    }
  );
  assert.deepEqual(
    attachCommand({ agentName: 'chief-khaliq', mode: 'drive', residentChief: true }),
    { command: 'sh', args: ['scripts/chief.sh', 'brain', 'drive'] }
  );
});

test('fleet agent gives the attach process the pane TTY and project cwd', async () => {
  const spawned = [];
  const reports = [];
  const child = new EventEmitter();
  const running = runFleetAgent({
    environment: {
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
      HERDR_PANE_ID: 'w9:p2',
      HERDR_RELAY_AGENT_NAME: 'worker',
      HERDR_RELAY_AGENT_LABEL: 'codex',
      HERDR_RELAY_ATTACH_MODE: 'passthrough',
    },
    listAgents: async () => [{ name: 'worker', current_state: 'working' }],
    request: async (_socketPath, method, params) => {
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
  await running;

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'agent-relay');
  assert.deepEqual(spawned[0].args, [
    'node',
    'agent',
    'attach',
    'worker',
    '--mode',
    'passthrough',
  ]);
  assert.equal(spawned[0].options.cwd, process.cwd());
  assert.equal(spawned[0].options.stdio, 'inherit');
  assert.deepEqual(reports.map((report) => report.params.state), ['working']);
  assert.equal(reports[0].params.source, 'fleet-picker');
});

test('fleet project defaults to the active Herdr workspace cwd and allows an explicit override', () => {
  assert.equal(
    fleetProjectDir({ HERDR_PLUGIN_CONTEXT_JSON: '{"workspace_cwd":"/projects/chief"}' }, '/plugin'),
    '/projects/chief'
  );
  assert.equal(
    fleetProjectDir(
      {
        HERDR_RELAY_PROJECT_DIR: '/projects/other-chief',
        HERDR_PLUGIN_CONTEXT_JSON: '{"workspace_cwd":"/projects/chief"}',
      },
      '/plugin'
    ),
    '/projects/other-chief'
  );
});

test('manifest exposes the fleet picker and Chief-cwd attach entrypoints', async () => {
  const manifest = await readFile(join(process.cwd(), 'herdr-plugin.toml'), 'utf8');
  assert.match(manifest, /id = "fleet"/);
  assert.match(manifest, /id = "fleet-agent"/);
  assert.match(manifest, /HERDR_PLUGIN_ROOT\/dist\/fleet-agent\.mjs/);
});
