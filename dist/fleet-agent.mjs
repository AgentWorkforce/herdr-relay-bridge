import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  attachCommand,
  attachMode,
  createStatusProjector,
  listBrokerAgents,
} from './fleet.mjs';
import { requestHerdr } from './herdr-socket.mjs';

export const DEFAULT_POLL_INTERVAL_MS = 5_000;

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

export async function runFleetAgent({
  environment = process.env,
  listAgents = listBrokerAgents,
  request = requestHerdr,
  spawnProcess = spawn,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const socketPath = environment.HERDR_SOCKET_PATH;
  const paneId = environment.HERDR_PANE_ID;
  const agentName = environment.HERDR_RELAY_AGENT_NAME;
  const agentLabel = environment.HERDR_RELAY_AGENT_LABEL || 'agent-relay';
  if (!socketPath || !paneId) throw new Error('Herdr did not provide the fleet pane context');
  if (!agentName) throw new Error('Fleet pane did not receive an Agent Relay agent name');

  const projectDir = process.cwd();
  const mode = attachMode(environment.HERDR_RELAY_ATTACH_MODE);
  const projector = createStatusProjector({
    agentName,
    initialBrokerState:
      environment.HERDR_RELAY_INITIAL_STATE === undefined
        ? undefined
        : environment.HERDR_RELAY_INITIAL_STATE,
    loadAgents: () => listAgents(projectDir),
    report: ({ state, message }) =>
      request(socketPath, 'pane.report_agent', {
        pane_id: paneId,
        source: 'fleet-picker',
        agent: agentLabel,
        state,
        message,
      }),
  });

  await projector.poll();
  const invocation = attachCommand({
    agentName,
    mode,
    residentChief: environment.HERDR_RELAY_RESIDENT_CHIEF === '1',
  });
  const child = spawnProcess(invocation.command, invocation.args, {
    cwd: projectDir,
    env: environment,
    stdio: 'inherit',
  });

  let stopped = false;
  let timer;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await projector.poll();
      } catch {
        // Keep the attach usable while Herdr is restarting. Because the
        // projector advances only after a successful report, the next poll
        // retries the same broker transition.
      } finally {
        schedule();
      }
    }, pollIntervalMs);
    timer.unref?.();
  };
  schedule();

  try {
    const result = await waitForChild(child);
    if (result.code && result.code !== 0) {
      throw new Error(`${agentName} attach exited with status ${result.code}`);
    }
    return result;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
  }
}

export function isDirectEntrypoint(moduleUrl, argv1) {
  return Boolean(argv1) && moduleUrl === pathToFileURL(argv1).href;
}

export async function main() {
  try {
    await runFleetAgent();
  } catch (error) {
    console.error(`Agent Relay fleet attach failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) await main();
