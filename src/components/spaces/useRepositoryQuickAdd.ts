// Repository head-row quick add — the three actions SpacesRepositoryGroup's
// '+' menu can take, wired once for the whole pane.
//
// Where the session starts is already decided by the time these run: the group
// resolved it with repositoryQuickAddTarget. These only open a pane there, or
// hand the same location to the canonical add-agent run.
//
// Every store read is handler-time (the accessors in useSpacesPaneState), so
// all three callbacks keep one identity for the pane's life — a memoized
// repository group must not re-render because an account or host record moved.

import { useCallback, useRef } from "react";
import {
	ensureProjectForPath,
	readAccounts,
	readActiveAccountId,
	readAgents,
	readSpaceById,
	readSshHosts,
} from "@/components/spaces/useSpacesPaneState";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import {
	type PreparedCanonicalAddAgentRun,
	prepareCanonicalAddAgentRun,
	runPreparedCanonicalAddAgentPresenting,
	shouldRetryCanonicalAddAgentAction,
	supportsCanonicalAddAgentRun,
} from "@/lib/agents/addAgentCanonicalRun";
import { addAgent } from "@/lib/agents/agentRegistration";
import { t } from "@/lib/i18n";
import { beginManagedRuntimeEnsure } from "@/lib/sessions/launch/managedRuntimeEnsure";
import { ensureProviderLaunchDefaultsProjection } from "@/lib/settings/providerLaunchDefaults";
import {
	quickAddAgentName,
	type RepositoryQuickAddTarget,
} from "@/lib/spaces/repositoryQuickAdd";
import { repositoryQuickAgentPolicy } from "@/lib/spaces/repositoryQuickAgentLaunch";
import { showErrorToast } from "@/lib/toast";
import {
	openAgentPanel,
	openLocalTerminalOn,
	openRemoteSshTerminalOn,
	withDesktopDockview,
} from "@/lib/workspace/dock";
import { agentSpawnInteractionPreference } from "@/lib/workspace/pane/interfaceMode";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import { spaceWindowLabel } from "@/lib/workspace/window/windowLabel";
import type { Agent, Provider } from "@/types";

/** The add-agent dialog target the pane owns — quick-add fills it in for the
 *  cases that need a decision (or that the canonical run cannot take). */
export interface RepositoryAddAgentDialogTarget {
	desktopId: string;
	host?: { id: string; name: string };
	initialPath?: string;
	initialProvider?: Provider;
}

/** The SSH host a remote target belongs to, read when the action runs.
 *  A local target has none, and an unknown host id resolves to none — both
 *  fall through to the local path, which is what an unregistered host is. */
function targetHost(target: RepositoryQuickAddTarget) {
	return target.hostId
		? readSshHosts().find((candidate) => candidate.id === target.hostId)
		: undefined;
}

function repositoryAgentActionKey(
	desktopId: string,
	target: RepositoryQuickAddTarget,
	provider: Provider,
): string {
	return JSON.stringify([
		desktopId,
		target.hostId ?? null,
		target.path,
		provider,
	]);
}

interface PendingRepositoryAgentAction {
	readonly preparation: Promise<
		PreparedCanonicalAddAgentRun | { remoteAgent: Agent }
	>;
	attempt: Promise<void> | null;
}

export function useRepositoryQuickAdd(
	openAddAgentDialog: (target: RepositoryAddAgentDialogTarget) => void,
	position?: PanelPosition,
	/** The pane the quick add runs in (a launcher pane), so a failure lands
	 * there; the sidebar and the watermark have no pane and report to the
	 * workspace. */
	paneId?: string,
) {
	const interfaceMode = useInterfaceMode();
	const pendingAgentActions = useRef(
		new Map<string, PendingRepositoryAgentAction>(),
	);
	const onAddRepositoryTerminal = useCallback(
		(desktopId: string, target: RepositoryQuickAddTarget) => {
			withDesktopDockview(desktopId, (api) => {
				// A remote repository opens on its own host — a local terminal
				// pointed at a remote path lands in a directory that is not there.
				const host = targetHost(target);
				if (host) {
					openRemoteSshTerminalOn(api, host.id, host.name, target.path);
					return;
				}
				openLocalTerminalOn(api, target.path);
			});
		},
		[],
	);

	const onAddRepositoryAgentWithOptions = useCallback(
		(
			desktopId: string,
			target: RepositoryQuickAddTarget,
			provider?: Provider,
		) => {
			const host = targetHost(target);
			openAddAgentDialog({
				desktopId,
				...(host ? { host: { id: host.id, name: host.name } } : {}),
				initialPath: target.path,
				...(provider ? { initialProvider: provider } : {}),
			});
		},
		[openAddAgentDialog],
	);

	const onAddRepositoryAgent = useCallback(
		async (
			desktopId: string,
			target: RepositoryQuickAddTarget,
			provider: Provider,
		) => {
			try {
				const project = await ensureProjectForPath(target.path, target.hostId);
				const space = readSpaceById(desktopId);
				const actionKey = repositoryAgentActionKey(desktopId, target, provider);
				let action = pendingAgentActions.current.get(actionKey);
				if (!action) {
					const policy = repositoryQuickAgentPolicy({
						project,
						provider,
						actionId: crypto.randomUUID(),
						agentName: quickAddAgentName(
							provider,
							readAgents()
								.filter((agent) => agent.projectId === project.id)
								.map((agent) => agent.name),
						),
						accounts: readAccounts(),
						activeAccountId: readActiveAccountId(provider),
						interactionPreference: agentSpawnInteractionPreference(),
					});
					if (project.kind !== "ssh" && !supportsCanonicalAddAgentRun(policy)) {
						onAddRepositoryAgentWithOptions(desktopId, target, provider);
						return;
					}
					action = {
						preparation:
							project.kind === "ssh"
								? ensureProviderLaunchDefaultsProjection().then(async () => ({
										remoteAgent: await addAgent({
											projectId: project.id,
											name: policy.agentName,
											provider,
											accountId: policy.accountId,
											useWorktree: false,
										}),
									}))
								: prepareCanonicalAddAgentRun(policy),
						attempt: null,
					};
					pendingAgentActions.current.set(actionKey, action);
				}
				let prepared: Awaited<PendingRepositoryAgentAction["preparation"]>;
				try {
					prepared = await action.preparation;
				} catch (cause) {
					if (pendingAgentActions.current.get(actionKey) === action) {
						pendingAgentActions.current.delete(actionKey);
					}
					throw cause;
				}
				const attempt =
					action.attempt ??
					("remoteAgent" in prepared
						? (async () => {
								const agent = prepared.remoteAgent;
								const runtime = beginManagedRuntimeEnsure(agent, {
									columns: 120,
									rows: 30,
								});
								if (runtime?.source !== "ssh")
									throw new Error("remote_managed_runtime_binding_missing");
								const receipt = await runtime.receipt;
								withDesktopDockview(desktopId, () =>
									openAgentPanel(desktopId, receipt.agent, position),
								);
							})()
						: runPreparedCanonicalAddAgentPresenting(
								prepared,
								space
									? {
											spaceId: space.id,
											windowLabel: spaceWindowLabel(space),
											...(position ? { position } : {}),
										}
									: null,
							)
					).then(() => undefined);
				action.attempt = attempt;
				try {
					await attempt;
					if (pendingAgentActions.current.get(actionKey) === action) {
						pendingAgentActions.current.delete(actionKey);
					}
				} catch (cause) {
					if (action.attempt === attempt) action.attempt = null;
					// Remote retries keep the registered Agent, as the dialog does.
					if (
						!("remoteAgent" in prepared) &&
						!shouldRetryCanonicalAddAgentAction(cause) &&
						pendingAgentActions.current.get(actionKey) === action
					) {
						pendingAgentActions.current.delete(actionKey);
					}
					throw cause;
				}
			} catch (cause) {
				const message = t("spaces.repository.startFailed", { e: String(cause) });
				if (paneId) showErrorToast(message, { paneId });
				else showErrorToast(message);
			}
		},
		[onAddRepositoryAgentWithOptions, interfaceMode, position, paneId],
	);

	return {
		onAddRepositoryTerminal,
		onAddRepositoryAgent,
		onAddRepositoryAgentWithOptions,
	};
}
