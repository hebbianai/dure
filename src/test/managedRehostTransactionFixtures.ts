import { managedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehost";
import type { ManagedAgentRehostInspection } from "@/lib/sessions/managed/managedAgentRehostInspection";
import type { ManagedAgentRecoveryResult } from "@/lib/sessions/managed/managedAgentRuntimeState";
import {
	nativeResumeCreateFixture,
	nativeResumePayloadFixture,
} from "@/test/managedNativeRehostFixtures";

/** Native execution is controlled; transaction, payload parsing and projection
 * remain real in both the UI/CLI integration suite and hidden WebView probe. */
export function managedRehostTransactionFixture(
	generation: number,
	conversationId = `conversation-${generation - 1}`,
) {
	const base = nativeResumePayloadFixture(generation);
	const inspection: ManagedAgentRehostInspection = {
		agentId: base.agentId,
		agentName: base.agentName,
		projectId: base.projectId,
		providerId: base.providerId,
		sourceBinding: base.sourceBinding,
		sourceConversationId: conversationId,
		sourceLifecycle: "ready",
		sourcePaneState: "present",
		conversationId,
		cwd: base.cwd,
		desktopId: base.desktopId,
		panelId: base.panelId,
		permissionMode: "default",
		terminalEnvironment: {},
		plan: {
			sessionId: base.sourceBinding.sessionId,
			sourceBuildId: "old-build",
			targetBuildId: "new-build",
			action: "replace_ai_provider_with_explicit_conversation",
			allowed: true,
			requiresConfirmation: true,
		},
	};
	const recovery: ManagedAgentRecoveryResult = {
		permissionMode: "default",
		conversationId,
		createIdempotencyKey: base.binding.createIdempotencyKey!,
		backendRouteAuthority: base.backendRouteAuthority,
		replacement: nativeResumeCreateFixture(generation).session,
		receipt: {
			sourceSessionId: base.sourceBinding.sessionId,
			operationId: base.operationId,
			targetBuildId: inspection.plan.targetBuildId,
			action: inspection.plan.action,
			outcome: "replaced",
			replayed: false,
		},
	};
	return {
		inspection,
		recovery,
		payload: managedAgentRehostSyncPayload(inspection, { recovery }),
	};
}
