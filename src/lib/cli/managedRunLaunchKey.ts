import {
	failCliManagedRunPresentation,
	type ManagedRunProjectionInput,
} from "@/lib/cli/managedRunPresentationModel";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { hmux } from "@/lib/ipc";

export interface ManagedRunLaunchKeyDependencies {
	inspectConversation: typeof hmux.inspectManagedConversationIdentity;
	inspectWriter: typeof hmux.inspectExistingManagedWriter;
}

const defaultDependencies: ManagedRunLaunchKeyDependencies = {
	inspectConversation: (request) =>
		hmux.inspectManagedConversationIdentity(request),
	inspectWriter: (request) => hmux.inspectExistingManagedWriter(request),
};

function workspaceRoot(request: ManagedRunProjectionInput): string {
	if (request.worktree.kind === "project_root") {
		return (
			request.projectPath ??
			failCliManagedRunPresentation(
				"client_project_root_unavailable",
				"backend project root is unavailable for client presentation",
			)
		);
	}
	if (request.worktree.kind === "dedicated") {
		return failCliManagedRunPresentation(
			"invalid_request",
			"an Agent runtime presentation names an existing workspace root",
		);
	}
	return request.worktree.rootPath;
}

/** The exact managed-create key of the live Host a presentation adopts. A Run
 * receipt or a backend transition names it; an app-launched Agent's initial
 * runtime records it only in the Host's create receipt. That receipt is read
 * through the existing-writer proof (healthy Host, same generation, provider,
 * permission, cwd, launch reference and conversation), so a pane never
 * re-creates or forks the Session under a guessed key. */
export async function resolveManagedRunLaunchKey(
	request: ManagedRunProjectionInput,
	dependencies: ManagedRunLaunchKeyDependencies = defaultDependencies,
): Promise<string> {
	if (request.launchIdempotencyKey) return request.launchIdempotencyKey;
	if (request.source !== "local") {
		return failCliManagedRunPresentation(
			"client_agent_runtime_launch_key_unavailable",
			"the backend did not report this remote runtime's launch key; open it from the app that launched it",
		);
	}
	const cwd = workspaceRoot(request);
	const target = {
		sessionId: request.sessionId,
		workspaceId: request.workspaceId,
		providerId: request.providerId,
	};
	let conversationId: string;
	try {
		conversationId = (
			await dependencies.inspectConversation({ ...target, cwd })
		).conversationId;
	} catch (error) {
		if (!request.providerConversationRef) throw error;
		conversationId = request.providerConversationRef;
	}
	const writer = await dependencies.inspectWriter({
		...target,
		conversationId,
		cwd,
		permissionMode:
			request.permissionMode === "skip_permissions"
				? "bypass_approvals"
				: "default",
		...(request.executionProfile?.kind === "credential_reference"
			? { launchReference: request.executionProfile.reference_id }
			: {}),
	});
	if (
		writer.session.sessionId !== request.sessionId ||
		writer.session.workspaceId !== request.workspaceId ||
		!writer.session.stopFence ||
		!sameHmuxManagedGeneration(writer.session.stopFence, request.generation) ||
		!writer.idempotencyKey
	) {
		return failCliManagedRunPresentation(
			"managed_session_generation_mismatch",
			"managed Run Session generation changed before presentation",
		);
	}
	return writer.idempotencyKey;
}
