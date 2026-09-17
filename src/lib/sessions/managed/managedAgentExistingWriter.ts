import { providerAccountDirectoryName } from "@/lib/agents/providers";
import { hmux } from "@/lib/ipc";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type { HmuxExistingManagedWriterInspection } from "@/lib/ipc/hmuxContracts";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	type HmuxManagedPaneBindingV1,
	hmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type { AccountProfile, Provider } from "@/types";

/** Minimum immutable source projection needed for a non-destructive writer
 * handoff. Manual rehost and spawn --reuse share this one boundary. */
export interface ManagedAgentExistingWriterSource {
	agentId: string;
	agentName: string;
	projectId: string;
	providerId: Provider;
	sourceBinding: HmuxManagedPaneBindingV1;
	sourceConversationId?: string;
	sourcePaneState: "present" | "absent";
	conversationId: string;
	cwd: string;
	desktopId: string;
	panelId: string;
	permissionMode: "default" | "bypass_approvals";
	/** Canonical source Agent credential, never an Hmux launch reference. */
	credentialId?: string;
}

export interface ManagedAgentDurableSuccessorSource
	extends ManagedAgentExistingWriterSource {
	backendRouteAuthority: DureBackendRouteAuthorityV1;
	sourcePermissionMode: "default" | "bypass_approvals";
	/** Account metadata is used only to map an authoritative Hmux launch
	 * reference to the Agent runtime's canonical credential id. */
	accounts: readonly AccountProfile[];
}

export interface ManagedAgentDurableSuccessorTarget {
	writer: HmuxExistingManagedWriterInspection;
	launchKind: "exact_resume" | "fresh";
	/** Hmux-domain identity used for the exact writer proof. */
	launchReference?: string;
	/** Agent-runtime projection; fresh intentionally remains null. */
	providerConversationRef: string | null;
	/** Canonical Agent credential id, never an opaque Hmux reference. */
	targetCredentialId: string | null;
}

function providerAccountLaunchAlias(
	account: AccountProfile,
): string | undefined {
	try {
		return providerAccountDirectoryName(account);
	} catch {
		return undefined;
	}
}

/** Map only provider-scoped account ids and their reviewed directory aliases.
 * An unmatched Hmux reference remains opaque to the Agent runtime. */
export function canonicalManagedAgentCredentialId(
	providerId: Provider,
	launchReference: string,
	accounts: readonly AccountProfile[],
): string | undefined {
	const providerAccounts = accounts.filter(
		(account) => account.provider === providerId,
	);
	const matches = new Set(
		providerAccounts.flatMap((account) =>
			account.id === launchReference ||
			providerAccountLaunchAlias(account) === launchReference
				? [account.id]
				: [],
		),
	);
	return matches.size === 1 ? matches.values().next().value : undefined;
}

/** Enumerate only the launch references verified to represent one canonical
 * root credential. The exact Hmux writer inspection remains authoritative. */
export function managedAgentCredentialLaunchReferences(
	providerId: Provider,
	credentialId: string | undefined,
	accounts: readonly AccountProfile[],
): readonly (string | undefined)[] {
	if (!credentialId) return [undefined];
	const references: (string | undefined)[] = [credentialId];
	const account = accounts.find(
		(candidate) =>
			candidate.provider === providerId && candidate.id === credentialId,
	);
	if (account) {
		const directoryReference = providerAccountLaunchAlias(account);
		if (directoryReference && directoryReference !== credentialId)
			references.push(directoryReference);
	}
	return references;
}

export function inspectExistingManagedWriter(
	inspection: ManagedAgentExistingWriterSource,
	sessionId: string,
	identity: { conversationId: string; launchReference?: string },
) {
	return hmux.inspectExistingManagedWriter({
		sessionId,
		workspaceId: inspection.sourceBinding.workspaceId,
		providerId: inspection.providerId,
		conversationId: identity.conversationId,
		cwd: inspection.cwd,
		permissionMode: inspection.permissionMode,
		launchReference: identity.launchReference,
	});
}

export function managedAgentDurableSuccessorSyncPayload(
	inspection: ManagedAgentDurableSuccessorSource,
	target: ManagedAgentDurableSuccessorTarget,
	operationId: string,
): ManagedAgentRehostSyncPayload {
	const writer = target.writer;
	const session = writer.session;
	if (
		!operationId.trim() ||
		session.sessionClass !== "managed" ||
		session.lifecycle !== "ready" ||
		!session.inputAllowed ||
		!session.stopFence ||
		session.workspaceId !== inspection.sourceBinding.workspaceId ||
		session.sessionId === inspection.sourceBinding.sessionId ||
		writer.permissionMode !== inspection.permissionMode ||
		writer.launchReference !== target.launchReference ||
		(target.launchKind === "exact_resume"
			? target.providerConversationRef === null ||
				writer.conversationId !== target.providerConversationRef
			: target.providerConversationRef !== null) ||
		!writer.idempotencyKey
	) {
		throw new PaneCommandError(
			"pane_changed",
			"existing managed writer lost its exact runtime identity",
		);
	}
	return {
		schemaVersion: 2,
		operationId,
		launchKind: target.launchKind,
		permissionMode: inspection.permissionMode,
		agentId: inspection.agentId,
		agentName: inspection.agentName,
		projectId: inspection.projectId,
		providerId: inspection.providerId,
		sourceBinding: { ...inspection.sourceBinding },
		sourceConversationId: inspection.sourceConversationId ?? null,
		backendRouteAuthority: inspection.backendRouteAuthority,
		sourcePaneState: inspection.sourcePaneState,
		sourcePermissionMode: inspection.sourcePermissionMode,
		cwd: inspection.cwd,
		conversationId: target.providerConversationRef,
		desktopId: inspection.desktopId,
		panelId: inspection.panelId,
		binding: {
			...hmuxManagedBinding(
				session.sessionId,
				session.workspaceId,
				target.targetCredentialId ?? undefined,
				undefined,
				session.stopFence,
				inspection.sourceBinding.backendProfileId,
			),
			createIdempotencyKey: writer.idempotencyKey,
		},
		targetCredentialId: target.targetCredentialId,
	};
}
