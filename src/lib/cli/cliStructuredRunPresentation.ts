import { parseAgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import { PROVIDER_IDS } from "@/lib/agents/providers";
import { presentStructuredRun } from "@/lib/agents/structuredRunPresentation";
import {
	type BackendPresentationTarget,
	parseBackendPresentationTarget,
} from "@/lib/cli/backendPresentationTarget";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import { containsCliControlCharacter } from "@/lib/cli/cliTextBoundary";
import { parseRunPresentationWorktree } from "@/lib/cli/runPresentationWorktree";
import type { DureStructuredAgentRunResultV1 } from "@/lib/ipc/dureAgentRun";
import {
	isDureBackendProfileIdV1,
	isDureDomainIdV1,
	isDureProviderConversationRefV1,
} from "@/lib/ipc/dureProtocolIdentity";
import { isRecord } from "@/lib/payloadGuards";
import type { Provider } from "@/types";

const CLI_REQUEST_KEYS = new Set([
	"schemaVersion",
	"interactionProfile",
	"backendProfileId",
	"source",
	"hostId",
	"remote",
	"backend",
	"operationId",
	"agentId",
	"agentName",
	"projectId",
	"projectPath",
	"providerId",
	"executionProfile",
	"providerConversationRef",
	"interactionSessionId",
	"workspaceId",
	"worktree",
	"permissionMode",
	"spaceId",
	"windowLabel",
	"referencePanelId",
]);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,511}$/;
const WINDOW_LABEL = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PATH_LENGTH = 4096;

interface CliStructuredRunPresentationRequest {
	run: DureStructuredAgentRunResultV1;
	target: {
		executionTarget: BackendPresentationTarget;
		projectPath?: string;
		spaceId: string;
		windowLabel: string;
		referencePanelId?: string;
	};
}

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

function hasOnlyAllowedKeys(
	value: Record<string, unknown>,
	allowed: Set<string>,
) {
	return Object.keys(value).every((key) => allowed.has(key));
}

function token(value: unknown, label: string): string {
	if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
		fail("invalid_request", `${label} is invalid`);
	}
	return value;
}

function projectPath(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		!value ||
		value.length > MAX_PATH_LENGTH ||
		containsCliControlCharacter(value)
	) {
		fail("invalid_request", "projectPath is invalid");
	}
	return value;
}

function parseCliStructuredRunPresentationRequest(
	value: unknown,
): CliStructuredRunPresentationRequest {
	if (
		!isRecord(value) ||
		!hasOnlyAllowedKeys(value, CLI_REQUEST_KEYS) ||
		value.schemaVersion !== 1 ||
		value.interactionProfile !== "structured_protocol" ||
		(value.permissionMode !== "default" &&
			value.permissionMode !== "auto_edit" &&
			value.permissionMode !== "skip_permissions")
	) {
		fail("invalid_request", "structured Run presentation request is invalid");
	}
	const backend = isRecord(value.backend) ? value.backend : undefined;
	const executionProfile = parseAgentExecutionProfileV1(value.executionProfile);
	const providerId = token(value.providerId, "providerId");
	const backendProfileId = value.backendProfileId;
	const operationId = value.operationId;
	const providerConversationRef =
		value.providerConversationRef == null
			? null
			: value.providerConversationRef;
	if (
		!backend ||
		!hasOnlyAllowedKeys(backend, new Set(["id", "generation"])) ||
		!executionProfile ||
		!PROVIDER_IDS.includes(providerId as Provider) ||
		!isDureBackendProfileIdV1(backendProfileId) ||
		!isDureDomainIdV1(operationId) ||
		(providerConversationRef !== null &&
			!isDureProviderConversationRefV1(providerConversationRef))
	) {
		fail("invalid_request", "structured Run identity is invalid");
	}
	const executionTarget =
		value.source === undefined &&
		value.hostId === undefined &&
		value.remote === undefined &&
		backendProfileId === "local"
			? ({ source: "local", hostId: "local" } as const)
			: parseBackendPresentationTarget(value, fail);
	if (
		executionTarget.source === "ssh" &&
		executionTarget.hostId !== backendProfileId
	) {
		fail("invalid_request", "backend profile identity is inconsistent");
	}
	const selectedProjectPath = projectPath(value.projectPath);
	const windowLabel = value.windowLabel;
	if (typeof windowLabel !== "string" || !WINDOW_LABEL.test(windowLabel)) {
		fail("invalid_request", "windowLabel is invalid");
	}
	return {
		run: {
			schemaVersion: 1,
			backend: {
				id: token(backend.id, "backend.id"),
				generation: token(backend.generation, "backend.generation"),
			},
			operationId,
			agentId: token(value.agentId, "agentId"),
			agentName: token(value.agentName, "agentName"),
			projectId: token(value.projectId, "projectId"),
			providerId: providerId as Provider,
			executionProfile,
			providerConversationRef,
			workspaceId: token(value.workspaceId, "workspaceId"),
			worktree:
				parseRunPresentationWorktree(value.worktree) ??
				fail("invalid_request", "worktree is invalid"),
			permissionMode: value.permissionMode,
			interactionProfile: "structured_protocol",
			backendProfileId,
			interactionSessionId: token(
				value.interactionSessionId,
				"interactionSessionId",
			),
		},
		target: {
			executionTarget,
			...(selectedProjectPath ? { projectPath: selectedProjectPath } : {}),
			spaceId: token(value.spaceId, "spaceId"),
			windowLabel,
			...(value.referencePanelId === undefined
				? {}
				: {
						referencePanelId: token(value.referencePanelId, "referencePanelId"),
					}),
		},
	};
}

interface CliStructuredRunPresentationDependencies {
	claim(reqId: string): Promise<boolean>;
	present(
		run: CliStructuredRunPresentationRequest["run"],
		target: CliStructuredRunPresentationRequest["target"],
	): Promise<unknown>;
}

const defaultDependencies: CliStructuredRunPresentationDependencies = {
	claim: claimCliRequest,
	present: presentStructuredRun,
};

function errorPayload(error: unknown) {
	return {
		code:
			error &&
			typeof error === "object" &&
			"code" in error &&
			typeof error.code === "string"
				? error.code
				: "structured_run_presentation_failed",
		message: error instanceof Error ? error.message : String(error),
	};
}

/** Projects one already-created structured Run into the selected client pane.
 * Runtime and timeline ownership stay in the backend; this handler only owns
 * the IDE presentation transaction. */
export async function handleCliStructuredRunPresentation(
	params: unknown,
	reqId: string,
	dependencies: CliStructuredRunPresentationDependencies = defaultDependencies,
) {
	let claimed = false;
	const claim = async () => {
		if (claimed) return true;
		claimed = await dependencies.claim(reqId);
		return claimed;
	};
	try {
		const request = parseCliStructuredRunPresentationRequest(params);
		if (!(await claim())) return null;
		return await dependencies.present(request.run, request.target);
	} catch (error) {
		if (!(await claim())) return null;
		return { ok: false, error: errorPayload(error) };
	}
}
