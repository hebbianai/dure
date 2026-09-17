import { PROVIDER_IDS } from "@/lib/agents/providers";
import type {
	RemoteHmuxCatalogTargetV1,
	RemoteHmuxManagedRehostReceiptV1,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import {
	remoteHmuxManagedRehost,
	remoteHmuxManagedRehostReconcile,
} from "@/lib/ipc";
import { shortManagedRuntimeDigest } from "@/lib/sessions/managed/managedAgentRuntimeState";
import {
	type RemoteHmuxManagedPaneBindingV1,
	remoteHmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import type { Provider, TerminalEnvironment } from "@/types";

const REMOTE_REHOST_ROWS = 24;
const REMOTE_REHOST_COLUMNS = 80;

export interface RemoteManagedRehostBrokerRoute {
	purpose: "credential_switch" | "build_rehost";
	target: RemoteHmuxCatalogTargetV1;
	binding: RemoteHmuxManagedPaneBindingV1;
	providerId?: Provider;
	targetCredentialId?: string;
	targetCredentialProfileDirectory?: string;
}

export interface RemoteManagedRehostBrokerRequest
	extends RemoteManagedRehostBrokerRoute {
	providerId: Provider;
	conversationId: string;
	permissionMode: "default" | "bypass_approvals";
	cwd: string;
	terminalEnvironment: TerminalEnvironment;
	expectedTargetBuildId?: string;
	/** Runs only when no durable operation can be reconciled. */
	prepareInitiate?: () => Promise<void>;
}

export interface RemoteManagedRehostBrokerReceipt {
	providerId: Provider;
	conversationId: string;
	replacementBinding: RemoteHmuxManagedPaneBindingV1;
}

function operationId(request: RemoteManagedRehostBrokerRoute): string {
	const seed = [
		request.purpose === "credential_switch"
			? "remote-managed-credential-switch-v2"
			: "remote-managed-build-rehost-v2",
		request.binding.workspaceId,
		request.binding.sessionId,
	].join("\0");
	const prefix =
		request.purpose === "credential_switch" ? "remote_switch" : "remote_rehost";
	return `${prefix}_${shortManagedRuntimeDigest(seed)}${shortManagedRuntimeDigest(`receipt\0${seed}`)}`;
}

function projectReceipt(
	request: RemoteManagedRehostBrokerRoute,
	receipt: RemoteHmuxManagedRehostReceiptV1,
): RemoteManagedRehostBrokerReceipt {
	const replacementProvider = PROVIDER_IDS.find(
		(providerId) => providerId === receipt.replacement.providerId,
	);
	if (!replacementProvider || receipt.conversationId === null) {
		throw new Error("remote_hmux_managed_rehost_provider_invalid");
	}
	const replacementCredentialProfileDirectory =
		request.targetCredentialProfileDirectory ??
		request.binding.credentialProfileDirectory;
	const requestedCredentialId =
		request.targetCredentialId ?? request.binding.credentialId;
	const legacyDirectoryReference = replacementCredentialProfileDirectory
		?.split("/")
		.pop();
	if (
		requestedCredentialId === undefined
			? receipt.launchReference !== undefined
			: receipt.launchReference !== requestedCredentialId &&
				receipt.launchReference !== legacyDirectoryReference
	) {
		throw new Error("remote_hmux_managed_rehost_launch_reference_conflict");
	}
	const replacementCredentialId =
		request.providerId !== undefined &&
		replacementProvider === request.providerId &&
		replacementCredentialProfileDirectory !== undefined &&
		requestedCredentialId !== undefined
			? requestedCredentialId
			: undefined;
	return {
		providerId: replacementProvider,
		conversationId: receipt.conversationId,
		replacementBinding: remoteHmuxManagedBinding(
			receipt.replacement.sessionId,
			receipt.replacement.workspaceId,
			request.binding.hostId,
			request.binding.commandBridgeNonce,
			receipt.replacement.idempotencyKey,
			{
				runnerPrincipal: receipt.replacement.runnerPrincipal,
				runnerInstance: receipt.replacement.runnerInstance,
				channelEpoch: receipt.replacement.channelEpoch,
				hostInstanceId: receipt.replacement.hostInstanceId,
				terminalEpoch: receipt.replacement.terminalEpoch,
			},
			replacementCredentialId,
			replacementCredentialProfileDirectory,
			request.binding.backendProfileId,
		),
	};
}

/** Replays only an existing Host journal operation. It never admits a stop. */
export async function reconcileRemoteManagedRehostBroker(
	request: RemoteManagedRehostBrokerRoute,
): Promise<RemoteManagedRehostBrokerReceipt | null> {
	const receipt = await remoteHmuxManagedRehostReconcile({
		target: request.target,
		operationId: operationId(request),
		sourceSessionId: request.binding.sessionId,
		sourceWorkspaceId: request.binding.workspaceId,
		bridgeNonce: request.binding.commandBridgeNonce,
	});
	return receipt ? projectReceipt(request, receipt) : null;
}

/** One journal-first broker for Agent-owned and terminal-owned remote sources. */
export async function executeRemoteManagedRehostBroker(
	request: RemoteManagedRehostBrokerRequest,
): Promise<RemoteManagedRehostBrokerReceipt> {
	const rehostOperationId = operationId(request);
	const reconcileRequest = {
		target: request.target,
		operationId: rehostOperationId,
		sourceSessionId: request.binding.sessionId,
		sourceWorkspaceId: request.binding.workspaceId,
		bridgeNonce: request.binding.commandBridgeNonce,
	} as const;
	let receipt = await remoteHmuxManagedRehostReconcile(reconcileRequest);
	if (!receipt) {
		try {
			const sourceFence = request.binding.stopFence;
			if (!sourceFence) {
				throw new Error("remote managed source fence is required");
			}
			if (!request.conversationId.trim()) {
				throw new Error("remote managed conversation identity is required");
			}
			await request.prepareInitiate?.();
			receipt = await remoteHmuxManagedRehost({
				...reconcileRequest,
				sourceFence,
				providerId: request.providerId,
				conversationId: request.conversationId,
				permissionMode: request.permissionMode,
				cwd: request.cwd,
				initialRows: REMOTE_REHOST_ROWS,
				initialColumns: REMOTE_REHOST_COLUMNS,
				terminalEnvironment: request.terminalEnvironment,
				...(request.expectedTargetBuildId
					? { expectedTargetBuildId: request.expectedTargetBuildId }
					: {}),
				...(request.targetCredentialId &&
				request.targetCredentialProfileDirectory
					? {
							targetCredentialId: request.targetCredentialId,
							targetCredentialProfileDirectory:
								request.targetCredentialProfileDirectory,
						}
					: {}),
			});
		} catch (error) {
			const completed = await remoteHmuxManagedRehostReconcile(
				reconcileRequest,
			).catch(() => null);
			if (!completed) throw error;
			receipt = completed;
		}
	}
	return projectReceipt(request, receipt);
}
