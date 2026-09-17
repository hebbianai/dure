import type { AgentRunReceiptWorktree } from "@/lib/agents/agentRunWorkspacePresentation";
import {
	type AgentExecutionProfileV1,
	parseAgentExecutionProfileV1,
	parseAgentInteractionBindingV1,
	sameAgentExecutionProfileV1,
} from "@/lib/agents/chat/agentConversationContract";
import { computePromptIdentity } from "@/lib/agents/promptIdentity";
import { parseHmuxManagedGenerationV1 } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { t } from "@/lib/i18n";
import {
	createDureBackendRequester,
	type DureBackendIdentity,
	type DureBackendInvoke,
	DureBackendRequestError,
	type DureBackendResponse,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	isDureDomainIdV1,
	isDureProviderConversationRefV1,
} from "@/lib/ipc/dureProtocolIdentity";
import { asRecord as record } from "@/lib/payloadGuards";
import { isGitCheckoutInstanceV1 } from "@/lib/scm/worktrees/gitCheckoutInstance";
import type { HmuxManagedStopFenceV1, Provider } from "@/types";
import { hasRequiredRuntimeFields as requiredFields } from "../../../cli/lib/contracts/agent-runtime.mjs";
import {
	isProviderEffortSelection,
	isProviderModelSelection,
} from "../../../cli/lib/contracts/provider-launch-selection.mjs";
import {
	completedWorktree,
	type DureAgentRunWorktreeV1,
	type ParsedWorktree,
	validAbsolutePath,
	type WireWorktree,
	wireWorktree,
} from "./dureAgentRunWorktree";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const encoder = new TextEncoder();

type DureAgentRunPermissionModeV1 =
	| "default"
	| "auto_edit"
	| "skip_permissions";
export type DureAgentRunPermissionOverrideV1 =
	| "require_approvals"
	| "auto_edit"
	| "bypass_approvals";

interface DureAgentRunRequestV1 {
	projectId?: string;
	projectPath?: string;
	providerId: Provider;
	executionProfile?: AgentExecutionProfileV1;
	agentName: string;
	worktree: DureAgentRunWorktreeV1;
	providerConversationRef?: string | null;
	permissionOverride?: DureAgentRunPermissionOverrideV1;
	prompt?: string;
	model?: string;
	effort?: string;
	setupCommand?: string;
	/** Pins the spawn to a PTY terminal surface even when the provider offers
	 * a structured chat runtime — the basic interface mode's creation
	 * contract. Absent keeps the provider default. */
	interactionPreference?: "native_cli";
	idempotencyKey: string;
}

interface DureAgentRunResultBaseV1 {
	schemaVersion: 1;
	backend: DureBackendIdentity;
	operationId: string;
	agentId: string;
	agentName: string;
	projectId: string;
	providerId: Provider;
	executionProfile: AgentExecutionProfileV1;
	workspaceId: string;
	providerConversationRef: string | null;
	worktree: AgentRunReceiptWorktree;
	permissionMode: DureAgentRunPermissionModeV1;
}

export type DureAgentRunResultV1 = DureAgentRunResultBaseV1 &
	(
		| {
				interactionProfile: "native_cli";
				preparedSessionId: string;
				sessionId: string;
				launchIdempotencyKey: string;
				generation: HmuxManagedStopFenceV1;
		  }
		| {
				interactionProfile: "structured_protocol";
				backendProfileId: string;
				interactionSessionId: string;
		  }
	);

export type DureNativeAgentRunResultV1 = Extract<
	DureAgentRunResultV1,
	{ interactionProfile: "native_cli" }
>;
export type DureStructuredAgentRunResultV1 = Extract<
	DureAgentRunResultV1,
	{ interactionProfile: "structured_protocol" }
>;

export interface DureAgentRunTransport {
	run(
		request: DureAgentRunRequestV1,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<DureAgentRunResultV1>;
}

const PROVIDER_SETUP_MESSAGES = new Map([
	["provider_executable_not_found", "ipc.dureRun.providerNotFound"],
	["provider_executable_not_executable", "ipc.dureRun.providerNotExecutable"],
	["provider_executable_lookup_failed", "ipc.dureRun.providerLookupFailed"],
	["provider_executable_path_missing", "ipc.dureRun.providerPathMissing"],
]);

class DureAgentRunError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		const reason = details?.reasonCode;
		const key =
			code === "agent_spawn_provider_unavailable" && typeof reason === "string"
				? PROVIDER_SETUP_MESSAGES.get(reason)
				: undefined;
		super(key ? t(key) : message);
		this.name = "DureAgentRunError";
	}
}

interface ExpectedRun {
	request: DureAgentRunRequestV1;
	worktree: WireWorktree;
	promptDigest: string | null;
	executionProfile: AgentExecutionProfileV1;
}

interface ParsedPlan {
	operationId: string;
	planToken: string;
	projectId: string;
	agentId: string;
	agentName: string;
	providerId: Provider;
	workspaceId: string;
	executionProfile: AgentExecutionProfileV1;
	launch:
		| {
				interactionProfile: "native_cli";
				sessionId: string;
		  }
		| { interactionProfile: "structured_protocol" };
	permissionMode: DureAgentRunPermissionModeV1;
	promptDigest: string | null;
	providerConversationRef: string | null;
	worktree: ParsedWorktree;
}

interface ParsedReceiptBase {
	operationId: string;
	lastSequence: number;
	plan: ParsedPlan;
}

type ParsedReceiptLifecycle =
	| {
			state: "applying";
			recovery: { kind: "continue"; errorCode: null };
			terminalCode: null;
	  }
	| {
			state: "ready_to_succeed";
			recovery: { kind: "finish"; errorCode: null };
			terminalCode: null;
	  }
	| {
			state: "inspect_before_retry";
			recovery: { kind: "inspect_before_retry"; errorCode: null };
			terminalCode: null;
	  }
	| {
			state: "retry_required";
			recovery: {
				kind: "retry_required";
				stage: string;
				errorCode: string;
				/** One line of evidence the failing stage carried, when it had
				 *  any — the provider host's stderr tail, say. Free-form by
				 *  contract, so it is shown and never matched on. */
				detail: string | null;
			};
			terminalCode: null;
	  }
	| {
			state: "prompt_delivery_uncertain";
			recovery: {
				kind: "do_not_replay_prompt";
				errorCode: string | null;
				/** Evidence behind errorCode, when the stage carried any. */
				detail: string | null;
			};
			terminalCode: null;
	  }
	| {
			state: "succeeded";
			recovery: { kind: "none"; errorCode: null };
			terminalCode: null;
	  }
	| {
			state: "failed" | "manual_intervention_required";
			recovery: { kind: "none"; errorCode: null };
			terminalCode: string;
	  };

type ParsedReceipt = ParsedReceiptBase & ParsedReceiptLifecycle;

function parseReceiptLifecycle(
	state: unknown,
	recovery: Record<string, unknown>,
	terminalCode: unknown,
): ParsedReceiptLifecycle | null {
	const errorCode = token(recovery.error_code) ? recovery.error_code : null;
	// Bounded single-line prose, matching the backend's own admission rule.
	// Anything else is dropped rather than rejected: evidence must never be
	// the reason a receipt fails to parse.
	const detail =
		typeof recovery.error_detail === "string" &&
		recovery.error_detail.length > 0 &&
		recovery.error_detail.length <= 1024 &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the contract bans control characters
		!/[\u0000-\u001f\u007f\u2028\u2029]/.test(recovery.error_detail)
			? recovery.error_detail
			: null;
	if (terminalCode === null) {
		if (state === "applying" && recovery.kind === "continue") {
			return {
				state,
				recovery: { kind: recovery.kind, errorCode: null },
				terminalCode,
			};
		}
		if (state === "ready_to_succeed" && recovery.kind === "finish") {
			return {
				state,
				recovery: { kind: recovery.kind, errorCode: null },
				terminalCode,
			};
		}
		if (
			state === "inspect_before_retry" &&
			recovery.kind === "inspect_before_retry"
		) {
			return {
				state,
				recovery: { kind: recovery.kind, errorCode: null },
				terminalCode,
			};
		}
		if (
			state === "retry_required" &&
			recovery.kind === "retry_required" &&
			token(recovery.stage) &&
			errorCode
		) {
			return {
				state,
				recovery: {
					kind: recovery.kind,
					stage: recovery.stage,
					errorCode,
					detail,
				},
				terminalCode,
			};
		}
		if (
			state === "prompt_delivery_uncertain" &&
			recovery.kind === "do_not_replay_prompt"
		) {
			return {
				state,
				recovery: { kind: recovery.kind, errorCode, detail },
				terminalCode,
			};
		}
		if (state === "succeeded" && recovery.kind === "none") {
			return {
				state,
				recovery: { kind: recovery.kind, errorCode: null },
				terminalCode,
			};
		}
	}
	if (
		(state === "failed" || state === "manual_intervention_required") &&
		recovery.kind === "none" &&
		token(terminalCode)
	) {
		return {
			state,
			recovery: { kind: recovery.kind, errorCode: null },
			terminalCode,
		};
	}
	return null;
}

function token(value: unknown): value is string {
	return isDureDomainIdV1(value);
}

function validBranch(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		encoder.encode(value).length <= 256 &&
		!value.startsWith("-") &&
		!value.startsWith("/") &&
		!value.endsWith(".") &&
		!value.endsWith("/") &&
		!value.endsWith(".lock") &&
		value !== "@" &&
		!value.includes("..") &&
		!value.includes("@{") &&
		!value.includes("//") &&
		!value
			.split("/")
			.some(
				(component) =>
					!component ||
					component.startsWith(".") ||
					component.endsWith(".lock"),
			) &&
		!Array.from(value).some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 31 || code === 127 || " ~^:?*[\\".includes(character);
		})
	);
}

function validModel(model: string | undefined): boolean {
	return model === undefined || isProviderModelSelection(model);
}

function validEffort(effort: string | undefined): boolean {
	return effort === undefined || isProviderEffortSelection(effort);
}

function normalizedExecutionProfile(
	value: AgentExecutionProfileV1 | undefined,
): AgentExecutionProfileV1 {
	return value ?? { kind: "provider_default" };
}

function stageFailed(
	stage: string,
	errorCode: string,
	detail: string | null,
	details: Record<string, unknown>,
): DureAgentRunError {
	const message = t("ipc.dureRun.stageFailed", { stage, code: errorCode });
	return new DureAgentRunError(
		"agent_run_stage_failed",
		// The evidence goes in the message, not just the details: the OS
		// dialogs that report a failed start show the message alone.
		detail ? `${message} ${detail}` : message,
		{ ...details, stage, errorCode, ...(detail ? { detail } : {}) },
	);
}

function invalidReceipt(): DureAgentRunError {
	return new DureAgentRunError(
		"agent_run_receipt_invalid",
		t("ipc.dureRun.receiptMismatch"),
	);
}

function validOptionalConversationRef(value: unknown): value is string | null {
	return value === null || isDureProviderConversationRefV1(value);
}

function parseExistingWorkspaceSource(
	value: unknown,
	expected: Extract<WireWorktree, { kind: "existing_workspace" }>,
	context: {
		projectId: string;
		providerId: Provider;
		executionProfile: AgentExecutionProfileV1;
	},
): Extract<ParsedWorktree, { kind: "existing_workspace" }> {
	const source = record(value);
	const selection = record(source?.runtimeSelection);
	const binding = record(source?.runtimeBinding);
	const selectionExecutionProfile = parseAgentExecutionProfileV1(
		selection?.executionProfile,
	);
	if (
		!source ||
		!selection ||
		!binding ||
		!requiredFields(source, [
			"sourceAgentId",
			"workspaceId",
			"projectId",
			"providerId",
			"workspaceRoot",
			"workspaceBaseCommitSha",
			"runtimeSelection",
			"runtimeBinding",
		]) ||
		source.sourceAgentId !== expected.source_agent_id ||
		source.workspaceId !== expected.workspace_id ||
		source.projectId !== context.projectId ||
		source.providerId !== context.providerId ||
		!validAbsolutePath(source.workspaceRoot) ||
		!(
			source.workspaceBaseCommitSha === null ||
			(typeof source.workspaceBaseCommitSha === "string" &&
				GIT_OBJECT_ID.test(source.workspaceBaseCommitSha))
		) ||
		!requiredFields(selection, [
			"revision",
			"interactionProfile",
			"executionProfile",
			"permissionMode",
			"model",
			"effort",
		]) ||
		!Number.isSafeInteger(selection.revision) ||
		Number(selection.revision) < 1 ||
		!selectionExecutionProfile ||
		!sameAgentExecutionProfileV1(
			selectionExecutionProfile,
			context.executionProfile,
		) ||
		!["default", "auto_edit", "skip_permissions"].includes(
			String(selection.permissionMode),
		) ||
		!(
			selection.model === null ||
			(typeof selection.model === "string" && validModel(selection.model))
		) ||
		!(
			selection.effort === null ||
			(typeof selection.effort === "string" && validEffort(selection.effort))
		) ||
		selection.interactionProfile !== binding.interactionProfile
	) {
		throw invalidReceipt();
	}
	if (binding.interactionProfile === "native_cli") {
		const expectedCredentialReferenceId =
			selectionExecutionProfile.kind === "credential_reference"
				? selectionExecutionProfile.reference_id
				: null;
		if (
			!requiredFields(binding, [
				"interactionProfile",
				"runtimeKindId",
				"sessionId",
				"providerConversationRef",
				"credentialReferenceId",
				"bindingGeneration",
				"runtimeWorkspaceId",
				"runnerPrincipal",
				"runnerInstance",
				"channelEpoch",
				"hostInstanceId",
				"terminalEpoch",
			]) ||
			![
				binding.runtimeKindId,
				binding.sessionId,
				binding.runtimeWorkspaceId,
				binding.runnerPrincipal,
				binding.runnerInstance,
				binding.channelEpoch,
				binding.hostInstanceId,
				binding.terminalEpoch,
			].every(token) ||
			binding.runtimeWorkspaceId !== expected.workspace_id ||
			!validOptionalConversationRef(binding.providerConversationRef) ||
			!(
				binding.credentialReferenceId === null ||
				token(binding.credentialReferenceId)
			) ||
			binding.credentialReferenceId !== expectedCredentialReferenceId ||
			!Number.isSafeInteger(binding.bindingGeneration) ||
			Number(binding.bindingGeneration) < 1
		) {
			throw invalidReceipt();
		}
	} else if (binding.interactionProfile === "structured_protocol") {
		const runtime = record(binding.runtime);
		if (
			!requiredFields(binding, [
				"interactionProfile",
				"interactionSessionId",
				"providerConversationRef",
				"runtime",
				"timelineEpoch",
				"bindingRevision",
			]) ||
			!token(binding.interactionSessionId) ||
			!validOptionalConversationRef(binding.providerConversationRef) ||
			!runtime ||
			!requiredFields(runtime, ["runtimeGeneration", "providerEpoch"]) ||
			!token(runtime.runtimeGeneration) ||
			!token(runtime.providerEpoch) ||
			!token(binding.timelineEpoch) ||
			!Number.isSafeInteger(binding.bindingRevision) ||
			Number(binding.bindingRevision) < 1
		) {
			throw invalidReceipt();
		}
	} else {
		throw invalidReceipt();
	}
	return {
		kind: "existing_workspace",
		source_agent_id: expected.source_agent_id,
		workspace_id: expected.workspace_id,
		workspace_root: source.workspaceRoot,
	};
}

function parseWorktree(
	value: unknown,
	expected: WireWorktree,
	context: {
		projectId: string;
		providerId: Provider;
		executionProfile: AgentExecutionProfileV1;
	},
): ParsedWorktree {
	const worktree = record(value);
	if (
		worktree &&
		expected.kind === "existing_checkout" &&
		worktree.kind === "existing_checkout"
	) {
		const instance = worktree.instance;
		if (
			!requiredFields(worktree, ["kind", "instance", "branch", "base_commit_sha"]) ||
			!isGitCheckoutInstanceV1(instance) ||
			instance.canonicalPath !== expected.reference.canonicalPath ||
			instance.gitCommonDir !== expected.reference.gitCommonDir ||
			instance.gitDir !== expected.reference.gitDir ||
			worktree.branch !== expected.reference.branch ||
			worktree.base_commit_sha !== expected.reference.head ||
			!GIT_OBJECT_ID.test(expected.reference.head)
		)
			throw invalidReceipt();
		return {
			kind: "existing_checkout",
			instance,
			branch: expected.reference.branch,
			base_commit_sha: expected.reference.head,
		};
	}
	if (
		worktree &&
		expected.kind === "project_root" &&
		worktree.kind === "project_root" &&
		requiredFields(worktree, ["kind"])
	) {
		return { kind: "project_root" };
	}
	if (
		worktree &&
		expected.kind === "existing_workspace" &&
		worktree.kind === "existing_workspace" &&
		requiredFields(worktree, ["kind", "source"])
	) {
		return parseExistingWorkspaceSource(worktree.source, expected, context);
	}
	if (
		!worktree ||
		expected.kind !== "dedicated" ||
		!requiredFields(worktree, ["kind", "branch", "base_commit_sha"]) ||
		worktree.kind !== "dedicated" ||
		worktree.branch !== expected.branch ||
		(worktree.branch_mode ?? "create") !== (expected.branch_mode ?? "create") ||
		(worktree.branch_mode !== undefined &&
			worktree.branch_mode !== "create" &&
			worktree.branch_mode !== "existing") ||
		worktree.checkout_path !== expected.checkout_path ||
		(worktree.checkout_path !== undefined &&
			!validAbsolutePath(worktree.checkout_path)) ||
		!validBranch(worktree.branch) ||
		typeof worktree.base_commit_sha !== "string" ||
		!GIT_OBJECT_ID.test(worktree.base_commit_sha) ||
		(expected.base_commit_sha !== undefined &&
			worktree.base_commit_sha !== expected.base_commit_sha)
	) {
		throw invalidReceipt();
	}
	return {
		kind: "dedicated",
		branch: worktree.branch,
		base_commit_sha: worktree.base_commit_sha,
		...(worktree.branch_mode === "existing"
			? { branch_mode: "existing" as const }
			: {}),
		...(typeof worktree.checkout_path === "string"
			? { checkout_path: worktree.checkout_path }
			: {}),
	};
}

function parsePlan(
	value: unknown,
	expected: ExpectedRun,
	backend: DureBackendIdentity,
): ParsedPlan {
	const plan = record(value);
	const authority = record(plan?.authority);
	const request = record(plan?.request);
	const launch = record(plan?.launch);
	const providerLaunchDefaults = record(plan?.providerLaunchDefaults);
	const executionProfile = parseAgentExecutionProfileV1(
		request?.executionProfile,
	);
	const expectedOverride = expected.request.permissionOverride ?? null;
	const expectedPermissionMode =
		expectedOverride === "require_approvals"
			? "default"
			: expectedOverride === "auto_edit"
				? "auto_edit"
				: expectedOverride === "bypass_approvals"
					? "skip_permissions"
					: undefined;
	const requestKeys = [
		"schemaVersion",
		"idempotencyKey",
		"projectId",
		"providerId",
		"executionProfile",
		"agentName",
		"worktree",
		"providerConversationRef",
		"permissionMode",
		"promptDigest",
		...(expected.request.model === undefined ? [] : ["model"]),
		...(expected.request.effort === undefined ? [] : ["effort"]),
		...(expected.request.setupCommand === undefined ? [] : ["setupCommand"]),
		...(expected.request.interactionPreference === undefined
			? []
			: ["interactionPreference"]),
	];
	if (
		!plan ||
		!authority ||
		!request ||
		!launch ||
		!providerLaunchDefaults ||
		!requiredFields(plan, [
			"schemaVersion",
			"operationId",
			"authority",
			"request",
			"agentId",
			"workspaceId",
			"launch",
			"providerLaunchDefaults",
			"planToken",
		]) ||
		plan.schemaVersion !== 1 ||
		!token(plan.operationId) ||
		!SHA256.test(String(plan.planToken ?? "")) ||
		!requiredFields(authority, [
			"backendId",
			"backendGeneration",
			"projectId",
			"rootId",
			"repositoryId",
		]) ||
		authority.backendId !== backend.id ||
		!token(authority.backendGeneration) ||
		!token(authority.projectId) ||
		!token(authority.rootId) ||
		!token(authority.repositoryId) ||
		!requiredFields(request, requestKeys) ||
		request.schemaVersion !== 1 ||
		request.idempotencyKey !== expected.request.idempotencyKey ||
		request.projectId !== authority.projectId ||
		(expected.request.projectId !== undefined &&
			request.projectId !== expected.request.projectId) ||
		request.providerId !== expected.request.providerId ||
		!executionProfile ||
		!sameAgentExecutionProfileV1(executionProfile, expected.executionProfile) ||
		request.agentName !== expected.request.agentName ||
		request.providerConversationRef !==
			(expected.request.providerConversationRef ?? null) ||
		!["default", "auto_edit", "skip_permissions"].includes(
			String(request.permissionMode),
		) ||
		(expectedPermissionMode !== undefined &&
			request.permissionMode !== expectedPermissionMode) ||
		request.promptDigest !== expected.promptDigest ||
		request.model !== expected.request.model ||
		request.effort !== expected.request.effort ||
		request.setupCommand !== expected.request.setupCommand ||
		request.interactionPreference !== expected.request.interactionPreference ||
		!token(plan.agentId) ||
		!token(plan.workspaceId) ||
		!requiredFields(providerLaunchDefaults, [
			"schemaVersion",
			"revision",
			"fingerprint",
			"permissionOverride",
		]) ||
		providerLaunchDefaults.schemaVersion !== 1 ||
		!Number.isSafeInteger(providerLaunchDefaults.revision) ||
		Number(providerLaunchDefaults.revision) < 0 ||
		!SHA256.test(String(providerLaunchDefaults.fingerprint ?? "")) ||
		providerLaunchDefaults.permissionOverride !== expectedOverride
	) {
		throw invalidReceipt();
	}
	let parsedLaunch: ParsedPlan["launch"];
	if (launch.interactionProfile === "native_cli") {
		const runtime = record(launch.runtime);
		if (
			!requiredFields(launch, ["interactionProfile", "sessionId", "runtime"]) ||
			!token(launch.sessionId) ||
			!runtime ||
			!requiredFields(runtime, ["runtimeKindId", "requiredCapabilities"]) ||
			runtime.runtimeKindId !== "runtime.hmux" ||
			!Array.isArray(runtime.requiredCapabilities) ||
			runtime.requiredCapabilities.length === 0 ||
			!runtime.requiredCapabilities.every(token)
		) {
			throw invalidReceipt();
		}
		parsedLaunch = {
			interactionProfile: "native_cli",
			sessionId: launch.sessionId,
		};
	} else if (
		launch.interactionProfile === "structured_protocol" &&
		requiredFields(launch, ["interactionProfile"])
	) {
		parsedLaunch = { interactionProfile: "structured_protocol" };
	} else {
		throw invalidReceipt();
	}
	const parsedWorktree = parseWorktree(request.worktree, expected.worktree, {
		projectId: authority.projectId as string,
		providerId: request.providerId as Provider,
		executionProfile,
	});
	return {
		operationId: plan.operationId,
		planToken: plan.planToken as string,
		projectId: authority.projectId,
		agentId: plan.agentId,
		agentName: request.agentName as string,
		providerId: request.providerId as Provider,
		workspaceId: plan.workspaceId,
		executionProfile,
		launch: parsedLaunch,
		permissionMode: request.permissionMode as DureAgentRunPermissionModeV1,
		promptDigest: request.promptDigest as string | null,
		providerConversationRef: request.providerConversationRef as string | null,
		worktree: parsedWorktree,
	};
}

function parseReceipt(
	result: Record<string, unknown>,
	expected: ExpectedRun,
	backend: DureBackendIdentity,
): ParsedReceipt {
	const receipt = record(result.receipt);
	const recovery = record(receipt?.recovery);
	const lifecycle = recovery
		? parseReceiptLifecycle(receipt?.state, recovery, receipt?.terminalCode)
		: null;
	if (
		!requiredFields(result, ["schemaVersion", "receipt"]) ||
		result.schemaVersion !== 1 ||
		!receipt ||
		!requiredFields(
			receipt,
			[
				"schemaVersion",
				"operationId",
				"plan",
				"state",
				"lastSequence",
				"completed",
				"recovery",
				"terminalCode",
				"createdAtMs",
				"updatedAtMs",
			],
		) ||
		receipt.schemaVersion !== 1 ||
		!token(receipt.operationId) ||
		!Number.isSafeInteger(receipt.lastSequence) ||
		Number(receipt.lastSequence) < 1 ||
		!Array.isArray(receipt.completed) ||
		!lifecycle
	) {
		throw invalidReceipt();
	}
	const plan = parsePlan(receipt.plan, expected, backend);
	if (receipt.operationId !== plan.operationId) throw invalidReceipt();
	return {
		operationId: receipt.operationId,
		lastSequence: Number(receipt.lastSequence),
		plan,
		...lifecycle,
	};
}

function stageEvidence(
	completed: unknown[],
	index: number,
	expectedStage: string,
): Record<string, unknown> {
	const stage = record(completed[index]);
	const evidence = record(stage?.evidence);
	if (
		!stage ||
		!evidence ||
		stage.stage !== expectedStage ||
		!Number.isSafeInteger(stage.attempt) ||
		Number(stage.attempt) < 1 ||
		evidence.stage !== expectedStage
	) {
		throw invalidReceipt();
	}
	return evidence;
}

function parseSucceededRun(
	result: Record<string, unknown>,
	receipt: ParsedReceipt,
	backend: DureBackendIdentity,
	backendProfileId: string,
): DureAgentRunResultV1 {
	const raw = record(result.receipt);
	const completed = raw?.completed;
	const expectedStageCount = receipt.plan.promptDigest === null ? 2 : 3;
	if (
		!raw ||
		receipt.state !== "succeeded" ||
		!Array.isArray(completed) ||
		completed.length !== expectedStageCount
	) {
		throw invalidReceipt();
	}
	const workspaceEvidence = stageEvidence(completed, 0, "worktree");
	if (workspaceEvidence.workspace_id !== receipt.plan.workspaceId) {
		throw invalidReceipt();
	}
	const worktree = completedWorktree(
		receipt.plan.worktree,
		receipt.plan.workspaceId,
		workspaceEvidence,
		raw.checkoutRegistration,
	);
	if (!worktree) throw invalidReceipt();
	const base = {
		schemaVersion: 1,
		backend,
		operationId: receipt.operationId,
		agentId: receipt.plan.agentId,
		agentName: receipt.plan.agentName,
		projectId: receipt.plan.projectId,
		providerId: receipt.plan.providerId,
		executionProfile: receipt.plan.executionProfile,
		workspaceId: receipt.plan.workspaceId,
		providerConversationRef: receipt.plan.providerConversationRef,
		worktree,
		permissionMode: receipt.plan.permissionMode,
	} satisfies DureAgentRunResultBaseV1;
	if (receipt.plan.launch.interactionProfile === "native_cli") {
		const runtimeEvidence = stageEvidence(completed, 1, "runtime_launch");
		const session = record(runtimeEvidence.session);
		const generation = session
			? parseHmuxManagedGenerationV1({
					runnerPrincipal: session.runnerPrincipal,
					runnerInstance: session.runnerInstance,
					channelEpoch: session.channelEpoch,
					hostInstanceId: session.hostInstanceId,
					terminalEpoch: session.terminalEpoch,
				})
			: undefined;
		const preparedLaunchIdempotencyKey = `spawn-runtime:${receipt.operationId}`;
		const launchIdempotencyKey =
			runtimeEvidence.launch_idempotency_key === undefined
				? session?.sessionId === receipt.plan.launch.sessionId
					? preparedLaunchIdempotencyKey
					: undefined
				: token(runtimeEvidence.launch_idempotency_key)
					? runtimeEvidence.launch_idempotency_key
					: undefined;
		if (
			!session ||
			!token(session.sessionId) ||
			!generation ||
			!launchIdempotencyKey ||
			session.workspaceId !== receipt.plan.workspaceId ||
			session.providerId !== receipt.plan.providerId ||
			(session.sessionId === receipt.plan.launch.sessionId) !==
				(launchIdempotencyKey === preparedLaunchIdempotencyKey)
		) {
			throw invalidReceipt();
		}
		if (receipt.plan.promptDigest !== null) {
			const promptEvidence = stageEvidence(completed, 2, "prompt_delivery");
			if (
				promptEvidence.session_id !== session.sessionId ||
				!token(promptEvidence.delivery_id)
			) {
				throw invalidReceipt();
			}
		}
		return {
			...base,
			interactionProfile: "native_cli",
			preparedSessionId: receipt.plan.launch.sessionId,
			sessionId: session.sessionId,
			launchIdempotencyKey,
			generation,
		};
	}

	const launchEvidence = stageEvidence(completed, 1, "structured_launch");
	const binding = parseAgentInteractionBindingV1(launchEvidence.binding);
	if (
		!binding ||
		binding.agentId !== receipt.plan.agentId ||
		binding.providerId !== receipt.plan.providerId ||
		!validOptionalConversationRef(binding.providerConversationRef) ||
		!sameAgentExecutionProfileV1(
			binding.executionProfile,
			receipt.plan.executionProfile,
		) ||
		(receipt.plan.providerConversationRef !== null &&
			binding.providerConversationRef !== receipt.plan.providerConversationRef)
	) {
		throw invalidReceipt();
	}
	if (receipt.plan.promptDigest !== null) {
		const promptEvidence = stageEvidence(
			completed,
			2,
			"structured_prompt_delivery",
		);
		const runtime = record(promptEvidence.runtime);
		if (
			promptEvidence.interaction_session_id !== binding.interactionSessionId ||
			!runtime ||
			runtime.runtimeGeneration !== binding.runtime.runtimeGeneration ||
			runtime.providerEpoch !== binding.runtime.providerEpoch ||
			!token(promptEvidence.turn_id) ||
			!token(promptEvidence.client_message_id)
		) {
			throw invalidReceipt();
		}
	}
	return {
		...base,
		providerConversationRef: binding.providerConversationRef,
		interactionProfile: "structured_protocol",
		backendProfileId,
		interactionSessionId: binding.interactionSessionId,
	};
}

function transportError(error: unknown): DureAgentRunError {
	if (error instanceof DureAgentRunError) return error;
	const candidate = record(error);
	const code = candidate?.code;
	return new DureAgentRunError(
		token(code) ? code : "agent_run_transport_failed",
		error instanceof Error ? error.message : t("ipc.dureRun.requestFailed"),
		error instanceof DureBackendRequestError ? error.details : undefined,
	);
}

function shouldReconcileApplyFailure(error: unknown): boolean {
	return (
		error instanceof DureBackendRequestError &&
		(error.failure.kind === "transport" ||
			error.failure.kind === "contract" ||
			(error.failure.kind === "operation" &&
				error.failure.disposition === "retry_same"))
	);
}

function isBackendRouteChangeCode(code: string): boolean {
	return (
		code === "agent_run_backend_changed" ||
		code === "backend_transport_authority_changed" ||
		code === "backend_transport_generation_changed"
	);
}

function sameIntentRetryDetails(
	request: DureAgentRunRequestV1,
	preview: ParsedReceipt,
	extra?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		idempotencyKey: request.idempotencyKey,
		operationId: preview.operationId,
		retry: "same_intent",
		...extra,
	};
}

function canContinueRun(receipt: ParsedReceipt): boolean {
	return (
		receipt.recovery.kind === "continue" ||
		receipt.recovery.kind === "finish" ||
		receipt.recovery.kind === "inspect_before_retry" ||
		receipt.recovery.kind === "retry_required"
	);
}

function runReceiptError(
	request: DureAgentRunRequestV1,
	preview: ParsedReceipt,
	receipt: ParsedReceipt,
): DureAgentRunError {
	const state = {
		state: receipt.state,
		lastSequence: receipt.lastSequence,
	};
	if (receipt.state === "retry_required") {
		return stageFailed(
			receipt.recovery.stage,
			receipt.recovery.errorCode,
			receipt.recovery.detail,
			sameIntentRetryDetails(request, preview, state),
		);
	}
	if (receipt.state === "prompt_delivery_uncertain") {
		// The agent exists; what is unknown is whether it took up the task. Say
		// that, and say not to resend blindly — the prompt may already be in the
		// terminal (2026-09-01: this state used to be reported as success).
		const code = receipt.recovery.errorCode ?? "agent_spawn_prompt_uncertain";
		const message = t("ipc.dureRun.promptUncertain", { code });
		const detail = receipt.recovery.detail;
		return new DureAgentRunError(
			"agent_run_prompt_uncertain",
			detail ? `${message} ${detail}` : message,
			{
				...sameIntentRetryDetails(request, preview, state),
				errorCode: code,
				...(detail ? { detail } : {}),
			},
		);
	}
	const code =
		receipt.recovery.errorCode ??
		receipt.terminalCode ??
		`agent_spawn_${receipt.state}`;
	return new DureAgentRunError(
		code,
		code,
		canContinueRun(receipt)
			? sameIntentRetryDetails(request, preview, state)
			: { operationId: preview.operationId, ...state },
	);
}

export function canonicalAddAgentRunIdempotencyKey(actionId: string): string {
	return `add-agent:${actionId}`;
}

export function createDureAgentRunTransport(options?: {
	invokeCommand?: DureBackendInvoke;
}): DureAgentRunTransport {
	const backendRequest = createDureBackendRequester({
		invokeCommand: options?.invokeCommand,
		invalidResponseCode: "agent_run_response_invalid",
		invalidResponseMessage: t("ipc.dureRun.invalidResponse"),
		backendChangedCode: "agent_run_backend_changed",
		backendChangedMessage: t("ipc.dureBackend.generationChanged"),
		requestFailedCode: "agent_run_transport_failed",
		requestFailedMessage: t("ipc.dureRun.requestFailed"),
	});

	return {
		async run(request, routeAuthority) {
			const promptDigest = request.prompt
				? (await computePromptIdentity(request.prompt)).promptDigest
				: null;
			const expected = {
				request,
				worktree: wireWorktree(request.worktree),
				promptDigest,
				executionProfile: normalizedExecutionProfile(request.executionProfile),
			};
			try {
				let previewCall: DureBackendResponse;
				try {
					previewCall = await backendRequest(
						"agent_spawn.preview",
						{
							schemaVersion: 1,
							idempotencyKey: request.idempotencyKey,
							...(request.projectId
								? { projectId: request.projectId }
								: { projectPath: request.projectPath }),
							providerId: request.providerId,
							executionProfile: expected.executionProfile,
							agentName: request.agentName,
							worktree: expected.worktree,
							providerConversationRef: request.providerConversationRef ?? null,
							...(request.permissionOverride === undefined
								? {}
								: { permissionOverride: request.permissionOverride }),
							promptDigest,
							...(request.model ? { model: request.model } : {}),
							...(request.effort ? { effort: request.effort } : {}),
							...(request.setupCommand
								? { setupCommand: request.setupCommand }
								: {}),
							...(request.interactionPreference
								? { interactionPreference: request.interactionPreference }
								: {}),
						},
						{ kind: "exact", authority: routeAuthority },
					);
				} catch (previewError) {
					if (
						transportError(previewError).code !==
						"agent_spawn_idempotency_conflict"
					) {
						throw previewError;
					}
					try {
						previewCall = await backendRequest(
							"agent_spawn.status",
							{
								schemaVersion: 1,
								idempotencyKey: request.idempotencyKey,
							},
							{ kind: "exact", authority: routeAuthority },
						);
					} catch (statusError) {
						const failure = transportError(statusError);
						throw new DureAgentRunError(failure.code, failure.message, {
							idempotencyKey: request.idempotencyKey,
							retry: "same_intent",
						});
					}
				}
				const preview = parseReceipt(
					previewCall.result,
					expected,
					previewCall.backend,
				);
				const parseRunReceipt = (call: DureBackendResponse): ParsedReceipt => {
					const receipt = parseReceipt(call.result, expected, call.backend);
					if (
						receipt.operationId !== preview.operationId ||
						receipt.plan.planToken !== preview.plan.planToken
					) {
						throw invalidReceipt();
					}
					return receipt;
				};
				const statusAfter = async (
					applyError: unknown,
				): Promise<{ call: DureBackendResponse; receipt: ParsedReceipt }> => {
					const unresolvedOutcome = (statusError: unknown) => {
						const applyFailure = transportError(applyError);
						const statusFailure = transportError(statusError);
						const details = sameIntentRetryDetails(request, preview, {
							applyCode: applyFailure.code,
							statusCode: statusFailure.code,
						});
						const routeChange = [applyFailure, statusFailure].find((failure) =>
							isBackendRouteChangeCode(failure.code),
						);
						if (routeChange) {
							return new DureAgentRunError(
								routeChange.code,
								routeChange.message,
								details,
							);
						}
						return applyError instanceof DureAgentRunError
							? new DureAgentRunError(
									applyFailure.code,
									applyFailure.message,
									details,
								)
							: new DureAgentRunError(
									"agent_run_outcome_unknown",
									t("ipc.dureRun.requestFailed"),
									details,
								);
					};
					try {
						const call = await backendRequest(
							"agent_spawn.status",
							{
								schemaVersion: 1,
								idempotencyKey: request.idempotencyKey,
							},
							{ kind: "exact", authority: routeAuthority },
						);
						return { call, receipt: parseRunReceipt(call) };
					} catch (statusError) {
						throw unresolvedOutcome(statusError);
					}
				};
				const apply = async (
					receipt: ParsedReceipt,
				): Promise<{ call: DureBackendResponse; receipt: ParsedReceipt }> => {
					try {
						const call = await backendRequest(
							"agent_spawn.apply",
							{
								schemaVersion: 1,
								operationId: preview.operationId,
								planToken: preview.plan.planToken,
								expectedLastSequence: receipt.lastSequence,
								prompt: request.prompt ?? null,
							},
							{ kind: "exact", authority: routeAuthority },
						);
						try {
							return { call, receipt: parseRunReceipt(call) };
						} catch (responseError) {
							return statusAfter(responseError);
						}
					} catch (applyError) {
						if (shouldReconcileApplyFailure(applyError)) {
							const observed = await statusAfter(applyError);
							// A failed effect followed by the same journal is still that
							// failure. Newer receipts remain authoritative; lost transport
							// responses alone are not evidence of an execution refusal.
							if (
								applyError instanceof DureBackendRequestError &&
								applyError.failure.kind === "operation" &&
								observed.receipt.lastSequence === receipt.lastSequence &&
								observed.receipt.state !== "succeeded"
							) {
								throw new DureAgentRunError(
									applyError.code,
									applyError.message,
									{
										...applyError.details,
										...sameIntentRetryDetails(request, preview),
									},
								);
							}
							return observed;
						}
						if (
							applyError instanceof DureBackendRequestError &&
							applyError.failure.kind === "operation" &&
							applyError.failure.disposition !== "terminal"
						) {
							throw new DureAgentRunError(
								applyError.code,
								applyError.message,
								sameIntentRetryDetails(request, preview),
							);
						}
						throw applyError;
					}
				};
				const finish = ({
					call,
					receipt,
				}: {
					call: DureBackendResponse;
					receipt: ParsedReceipt;
				}) =>
					parseSucceededRun(
						call.result,
						receipt,
						call.backend,
						routeAuthority.profileId,
					);

				if (preview.state === "succeeded") {
					return finish({ call: previewCall, receipt: preview });
				}
				if (!canContinueRun(preview)) {
					throw runReceiptError(request, preview, preview);
				}
				let current = await apply(preview);
				if (current.receipt.state === "succeeded") return finish(current);
				if (!canContinueRun(current.receipt)) {
					throw runReceiptError(request, preview, current.receipt);
				}
				current = await apply(current.receipt);
				if (current.receipt.state === "succeeded") return finish(current);
				throw runReceiptError(request, preview, current.receipt);
			} catch (error) {
				throw transportError(error);
			}
		},
	};
}
