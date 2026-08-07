import { pathToFileURL } from 'node:url';

import { prepareCloudPane } from './cloud.mjs';
import { attachMode, fleetProjectDir, openedPane } from './fleet.mjs';
import { requestHerdr } from './herdr-socket.mjs';
import { waitForDismiss } from './fleet-picker.mjs';

export const CLOUD_AGENT_ENTRYPOINT = 'fleet-agent';

export async function runCloudPicker({
  environment = process.env,
  prepare = prepareCloudPane,
  request = requestHerdr,
  logger = console,
} = {}) {
  const socketPath = environment.HERDR_SOCKET_PATH;
  if (!socketPath) throw new Error('Herdr did not provide HERDR_SOCKET_PATH');
  const pluginId = environment.HERDR_PLUGIN_ID;
  if (!pluginId) throw new Error('Herdr did not provide HERDR_PLUGIN_ID');

  const projectDir = fleetProjectDir(environment);
  const mode = attachMode(environment.HERDR_RELAY_ATTACH_MODE);
  const prepared = await prepare({ environment });
  const label = prepared.cloudAgent.harness || 'agent-relay';
  const response = await request(socketPath, 'plugin.pane.open', {
    plugin_id: pluginId,
    entrypoint: CLOUD_AGENT_ENTRYPOINT,
    placement: 'tab',
    cwd: projectDir,
    focus: true,
    env: {
      HERDR_RELAY_AGENT_NAME: prepared.agentName,
      HERDR_RELAY_AGENT_LABEL: label,
      HERDR_RELAY_ATTACH_MODE: mode,
      RELAY_BROKER_URL: prepared.box.execUrl,
      ...(prepared.box.apiKey ? { RELAY_BROKER_API_KEY: prepared.box.apiKey } : {}),
    },
  });
  const pane = openedPane(response);
  try {
    await request(socketPath, 'pane.rename', {
      pane_id: pane.pane_id,
      label: prepared.agentName,
    });
  } catch (error) {
    logger.warn(`Could not label cloud pane ${pane.pane_id}: ${error.message}`);
  }
  logger.log(
    `Opened Daytona sandbox agent "${prepared.agentName}" as Herdr pane ${pane.pane_id}; ` +
      `working directory ${prepared.box.relayfileMountPath} is a live Relayfile mount.`
  );
  return {
    paneId: pane.pane_id,
    agentName: prepared.agentName,
    sandboxId: prepared.box.sandboxId,
    relayfileMountPath: prepared.box.relayfileMountPath,
  };
}

export function isDirectEntrypoint(moduleUrl, argv1) {
  return Boolean(argv1) && moduleUrl === pathToFileURL(argv1).href;
}

export async function main({ dismiss = waitForDismiss, pickerOptions } = {}) {
  try {
    await runCloudPicker(pickerOptions);
  } catch (error) {
    console.error(`Agent Relay cloud pane failed: ${error.message}`);
    process.exitCode = 1;
    await dismiss();
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) await main();
