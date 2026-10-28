/**
 * The editor's native quick pick for choosing among multiple discovered
 * projects. Deliberately not a webview concern: the webview can only ask the
 * host to open this (see the `change-project` message), never see or choose
 * from the candidate list itself: this file owns the entire selection UI.
 *
 * Each item carries the real `DiscoveredProject` object as data (the
 * platform returns the exact value the user picked), so there is no
 * ID-based lookup step that a forged value could target: the result is
 * always a reference into the same host-owned list `pickProject` was given.
 */

import { projectCandidateLabel } from '../core/workspace/scan.js';
import type { CancellationToken, HostPlatform, QuickPickItem } from './platform/hostPlatform.js';
import type { DiscoveredProject } from './projectResolution.js';

function toQuickPickItem(candidate: DiscoveredProject): QuickPickItem<DiscoveredProject> {
  return {
    label: projectCandidateLabel(candidate),
    description: candidate.manifestPath,
    detail: candidate.folder.path,
    value: candidate,
  };
}

/**
 * Shows the picker and resolves to the chosen candidate, or undefined if the
 * user cancelled (Escape, clicking away): callers are responsible for
 * deciding what cancellation means (leave the current selection alone for a
 * later change. Report a retryable "no project selected" state for the
 * first-ever selection).
 */
export async function pickProject(
  platform: HostPlatform,
  candidates: readonly DiscoveredProject[],
  token?: CancellationToken
): Promise<DiscoveredProject | undefined> {
  return platform.showQuickPick(
    candidates.map(toQuickPickItem),
    {
      title: 'Packageawy: Select a Project',
      placeholder: 'Choose which package.json to view',
      matchOnDescription: true,
      matchOnDetail: true,
    },
    token
  );
}
