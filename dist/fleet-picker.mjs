import { pathToFileURL } from 'node:url';

import {
  attachMode,
  brokerStateMessage,
  chiefAgentName,
  fleetProjectDir,
  listBrokerAgents,
  openedPane,
  projectBrokerState,
  relayAgentLabel,
} from './fleet.mjs';
import { requestHerdr } from './herdr-socket.mjs';

export const FLEET_WORKSPACE_LABEL = 'Relay fleet';
export const FLEET_AGENT_ENTRYPOINT = 'fleet-agent';

function createdWorkspace(response) {
  const workspace = response?.result?.workspace;
  const rootPane = response?.result?.root_pane;
  if (typeof workspace?.workspace_id !== 'string' || typeof rootPane?.pane_id !== 'string') {
    throw new Error('Herdr did not return the created fleet workspace');
  }
  return { workspaceId: workspace.workspace_id, rootPaneId: rootPane.pane_id };
}

export async function runFleetPicker({
  environment = process.env,
  listAgents = listBrokerAgents,
  findChief = chiefAgentName,
  request = requestHerdr,
  logger = console,
} = {}) {
  const socketPath = environment.HERDR_SOCKET_PATH;
  if (!socketPath) throw new Error('Herdr did not provide HERDR_SOCKET_PATH');
  const pluginId = environment.HERDR_PLUGIN_ID;
  if (!pluginId) throw new Error('Herdr did not provide HERDR_PLUGIN_ID');

  const projectDir = fleetProjectDir(environment);
  const mode = attachMode(environment.HERDR_RELAY_ATTACH_MODE);
  const agents = await listAgents(projectDir);
  if (!agents.length) {
    throw new Error(`No live Agent Relay broker agents were found for ${projectDir}`);
  }
  const residentChief = await findChief(projectDir);

  const created = createdWorkspace(
    await request(socketPath, 'workspace.create', {
      cwd: projectDir,
      label: FLEET_WORKSPACE_LABEL,
      focus: false,
    })
  );
  const opened = [];
  try {
    for (const agent of agents) {
      const label = relayAgentLabel(agent);
      const initialState = projectBrokerState(agent.current_state);
      const response = await request(socketPath, 'plugin.pane.open', {
        plugin_id: pluginId,
        entrypoint: FLEET_AGENT_ENTRYPOINT,
        placement: 'tab',
        workspace_id: created.workspaceId,
        cwd: projectDir,
        focus: false,
        env: {
          HERDR_RELAY_AGENT_NAME: agent.name,
          HERDR_RELAY_AGENT_LABEL: label,
          HERDR_RELAY_ATTACH_MODE: mode,
          HERDR_RELAY_INITIAL_STATE: String(agent.current_state || ''),
          HERDR_RELAY_RESIDENT_CHIEF: agent.name === residentChief ? '1' : '0',
        },
      });
      const pane = openedPane(response);
      opened.push({ agent: agent.name, paneId: pane.pane_id });

      await request(socketPath, 'pane.report_agent', {
        pane_id: pane.pane_id,
        source: 'fleet-picker',
        agent: label,
        state: initialState,
        message: brokerStateMessage(agent.name, agent.current_state),
      });
      await request(socketPath, 'pane.rename', { pane_id: pane.pane_id, label: agent.name });
    }

    await request(socketPath, 'pane.close', { pane_id: created.rootPaneId });
    await request(socketPath, 'workspace.focus', { workspace_id: created.workspaceId });
  } catch (error) {
    await request(socketPath, 'workspace.close', { workspace_id: created.workspaceId }).catch(() => undefined);
    throw error;
  }

  logger.log(
    `Opened ${opened.length} live Agent Relay agent pane(s) in ${FLEET_WORKSPACE_LABEL} from ${projectDir}.`
  );
  return { projectDir, workspaceId: created.workspaceId, panes: opened };
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
    await runFleetPicker();
  } catch (error) {
    console.error(`Agent Relay fleet picker failed: ${error.message}`);
    process.exitCode = 1;
    await dismiss();
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) await main();
