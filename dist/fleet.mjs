import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ATTACH_MODES = new Set(['view', 'drive', 'passthrough']);

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export class BrokerUnavailableError extends Error {
  constructor(projectDir, options = {}) {
    super(
      `Agent Relay broker is unavailable for ${projectDir}. ` +
        'Start it from that project with `agent-relay node up`, or run `sh scripts/chief.sh brain`, then retry.',
      options
    );
    this.name = 'BrokerUnavailableError';
  }
}

export function parseAgentList(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('Agent Relay returned an invalid agent list', { cause: error });
  }
  const agents = Array.isArray(parsed) ? parsed : parsed?.agents;
  if (!Array.isArray(agents)) throw new Error('Agent Relay returned an invalid agent list');
  return agents.filter((agent) => agent && typeof agent.name === 'string' && agent.name.trim());
}

export async function listBrokerAgents(projectDir, { run = runCommand } = {}) {
  let result;
  try {
    result = await run('agent-relay', ['node', 'agent', 'list'], { cwd: projectDir });
  } catch (error) {
    throw new BrokerUnavailableError(projectDir, { cause: error });
  }
  return parseAgentList(result.stdout);
}

export function projectBrokerState(state) {
  if (state === 'idle') return 'idle';
  if (state === 'working') return 'working';
  if (state === 'blocked' || state === 'blocked_on_send') return 'blocked';
  return 'unknown';
}

export function attachMode(value) {
  const mode = typeof value === 'string' && value.trim() ? value.trim() : 'drive';
  if (!ATTACH_MODES.has(mode)) {
    throw new Error('HERDR_RELAY_ATTACH_MODE must be view, drive, or passthrough');
  }
  return mode;
}

export function relayAgentLabel(agent) {
  for (const candidate of [agent?.cli, agent?.provider]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return 'agent-relay';
}

export function fleetProjectDir(environment = process.env, fallback = process.cwd()) {
  if (environment.HERDR_RELAY_PROJECT_DIR?.trim()) return environment.HERDR_RELAY_PROJECT_DIR.trim();
  let context;
  try {
    context = JSON.parse(environment.HERDR_PLUGIN_CONTEXT_JSON || '{}');
  } catch {
    context = {};
  }
  for (const candidate of [context.focused_pane_cwd, context.workspace_cwd]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

export async function chiefAgentName(projectDir, { read = readFile } = {}) {
  try {
    const roster = JSON.parse(await read(join(projectDir, 'teams.json'), 'utf8'));
    return roster?.agents?.find((agent) => agent?.role === 'chief of staff')?.name;
  } catch {
    return undefined;
  }
}

export function attachCommand({ agentName, mode, residentChief = false }) {
  if (residentChief) {
    return { command: 'sh', args: ['scripts/chief.sh', 'brain', mode] };
  }
  return {
    command: 'agent-relay',
    args: ['node', 'agent', 'attach', agentName, '--mode', mode],
  };
}

/**
 * The pane command for an agent the fleet node was asked to create rather than
 * one already live on the broker. `node agent new` spawns the agent and attaches
 * to it in the same terminal, so a single pane both starts the agent and shows
 * it — the broker stays the authority for the agent's existence.
 *
 * `--channels` is variadic, so it goes last: anything after it would be eaten as
 * a channel name.
 */
export function spawnCommand({ cli, agentName, mode, task, model, channels, cwd }) {
  const provider = typeof cli === 'string' ? cli.trim() : '';
  if (!provider) throw new Error('Spawning a Herdr pane agent requires a CLI provider');
  const name = typeof agentName === 'string' ? agentName.trim() : '';
  if (!name) throw new Error('Spawning a Herdr pane agent requires an agent name');

  const args = ['node', 'agent', 'new', provider, '--name', name, '--mode', mode];
  if (typeof task === 'string' && task.trim()) args.push('--task', task);
  if (typeof model === 'string' && model.trim()) args.push('--model', model.trim());
  // The agent's working directory, passed explicitly so the pane can keep its
  // own cwd pinned to the project whose broker owns the agent.
  if (typeof cwd === 'string' && cwd.trim()) args.push('--cwd', cwd.trim());
  const joinable = (channels ?? []).filter((channel) => typeof channel === 'string' && channel.trim());
  if (joinable.length) args.push('--channels', ...joinable.map((channel) => channel.trim()));
  return { command: 'agent-relay', args };
}

export function brokerStateMessage(agentName, brokerState) {
  const shown = typeof brokerState === 'string' && brokerState ? brokerState : 'unknown';
  return `${agentName}: broker state ${shown}`;
}

export function openedPane(response) {
  const pane = response?.result?.plugin_pane?.pane;
  if (typeof pane?.pane_id !== 'string') throw new Error('Herdr did not return the opened fleet pane');
  return pane;
}

/**
 * Run `stop` when Herdr takes the pane down. Herdr escalates pane shutdown
 * quickly after SIGHUP, so anything a pane must do before dying — releasing a
 * lock, deregistering a provider — has to hang off these.
 */
export function installStopHandlers(target, stop) {
  target.once('SIGINT', stop);
  target.once('SIGTERM', stop);
  if (target.platform !== 'win32') target.once('SIGHUP', stop);
}

export function createStatusProjector({
  agentName,
  initialBrokerState,
  loadAgents,
  report,
}) {
  let lastReported =
    initialBrokerState === undefined ? undefined : projectBrokerState(initialBrokerState);

  return {
    async poll() {
      let brokerState;
      let message;
      try {
        const agents = await loadAgents();
        const agent = agents.find((candidate) => candidate.name === agentName);
        brokerState = agent?.current_state;
        message = agent
          ? brokerStateMessage(agentName, brokerState)
          : `${agentName}: not present in the live broker agent list`;
      } catch {
        brokerState = undefined;
        message = `${agentName}: broker status unavailable`;
      }

      const state = projectBrokerState(brokerState);
      if (state === lastReported) return false;
      await report({ state, message });
      lastReported = state;
      return true;
    },
    current() {
      return lastReported;
    },
  };
}
