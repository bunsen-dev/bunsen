// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Out-of-band run cancellation.
 *
 * `cancelRun()` is the engine behind `bn runs cancel <run-id>`. It:
 *   1. Stops every Docker container labeled with the run's id (agent,
 *      scorer, proxy) and removes the run's network, freeing the resources
 *      a foreground `bn run` would normally tear down on exit.
 *   2. Flips the manifest to `canceled` and emits a terminal `run.canceled`
 *      event so downstream readers see a coherent end state.
 *
 * For runs whose foreground process is still alive, the executor's catch
 * path also notices the manifest flip (see `RunCanceledError` in
 * `executor.ts`) and surfaces a clean cancellation instead of the dockerode
 * 409 fallout from execs against the now-stopped container.
 */

import Docker from 'dockerode';
import {
  listBunsenContainers,
  listBunsenNetworks,
} from './container.js';
import { loadRunManifest, updateRunStatus } from './storage.js';
import { appendRunEvent } from './run-events.js';

export interface CancelRunResult {
  runId: string;
  /** Status before cancel; lets the caller distinguish no-op vs effective. */
  previousStatus: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';
  /** Number of containers we successfully stopped + removed. */
  containersStopped: number;
  /** Number of bunsen networks for this run we removed. */
  networksRemoved: number;
  /** True if we updated the manifest on this call. */
  manifestUpdated: boolean;
  /** Non-fatal errors encountered while stopping infra. */
  errors: string[];
}

const docker = new Docker();

export async function cancelRun(
  runId: string,
  baseDir: string = process.cwd()
): Promise<CancelRunResult> {
  const result: CancelRunResult = {
    runId,
    previousStatus: 'failed',
    containersStopped: 0,
    networksRemoved: 0,
    manifestUpdated: false,
    errors: [],
  };

  const manifest = loadRunManifest(runId, baseDir);
  if (!manifest) {
    throw new Error(`Run not found: ${runId}`);
  }
  result.previousStatus = manifest.status;

  // Already terminal — nothing to do.
  if (manifest.status !== 'pending' && manifest.status !== 'running') {
    return result;
  }

  // Stop containers labeled with this run id. We cover proxy/agent/scorer
  // in one sweep via the shared `bunsen.run-id` label.
  const containers = await listBunsenContainers().catch((err) => {
    result.errors.push(
      `Failed to list containers: ${err instanceof Error ? err.message : err}`
    );
    return [];
  });
  for (const c of containers) {
    if (c.runId !== runId) continue;
    try {
      const container = docker.getContainer(c.id);
      if (c.state === 'running') {
        await container.stop({ t: 5 });
      }
      await container.remove({ force: true });
      result.containersStopped++;
    } catch (err) {
      result.errors.push(
        `Failed to stop container ${c.name || c.id.slice(0, 12)}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Remove the per-run proxy network if one was created. Networks aren't
  // tagged with a run-id label today, so we match by name convention
  // (`bunsen-net-<runId>`) emitted by `startProxyContainer`.
  const networks = await listBunsenNetworks().catch((err) => {
    result.errors.push(
      `Failed to list networks: ${err instanceof Error ? err.message : err}`
    );
    return [] as { id: string; name: string }[];
  });
  for (const n of networks) {
    if (n.name !== `bunsen-net-${runId}`) continue;
    try {
      await docker.getNetwork(n.id).remove();
      result.networksRemoved++;
    } catch (err) {
      result.errors.push(
        `Failed to remove network ${n.name}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Flip manifest + emit terminal event. The foreground executor (if any
  // is still alive) will pick up the `canceled` status on its next
  // catch-block read and translate the docker-stop fallout into a
  // `RunCanceledError` rather than a generic failure.
  updateRunStatus(runId, 'canceled', 130, baseDir);
  result.manifestUpdated = true;
  try {
    appendRunEvent(runId, { event: 'run.canceled', data: { reason: 'external' } }, baseDir);
  } catch {
    // Event-stream emission is best-effort; the manifest flip is what's
    // load-bearing.
  }

  return result;
}
