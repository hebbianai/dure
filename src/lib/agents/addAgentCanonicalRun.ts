import { localAgentRunPresentationRequest } from "@/lib/agents/agentRunPresentation";
import {
	type AgentRunPresentationWorktree,
	agentRunPresentationWorktree,
} from "@/lib/agents/agentRunWorkspacePresentation";
import type { AgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import { computePromptIdentity } from "@/lib/agents/promptIdentity";
import { providerAccountDirectoryName } from "@/lib/agents/providers";
import {
	presentStructuredRun,
	presentStructuredRunInBackground,
} from "@/lib/agents/structuredRunPresentation";
import {
	ManagedRunPaneCommittedError,
	presentManagedRun,
} from "@/lib/cli/cliManagedRunPresentation";
import { presentManagedRunInBackground } from "@/lib/cli/managedRunBackgroundPresentation";
import { t } from "@/lib/i18n";
import {
	canonicalAddAgentRunIdempotencyKey,
	createDureAgentRunTransport,
	type DureAgentRunPermissionOverrideV1,
	type DureAgentRunResultV1,
} from "@/lib/ipc/dureAgentRun";
import type { DureAgentRunWorktreeV1 } from "@/lib/ipc/dureAgentRunWorktree";
import {
	createDureBackendRequester,
	resolveSelectedDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackend";
import {
	type DureBackendRouteAuthorityV1,
	sameDureBackendRouteTarget,
} from "@/lib/ipc/dureBackendRoute";
import {
	registerDureProviderCredentialProfile,
	supportsDureProviderCredentialSpawn,
} from "@/lib/ipc/dureProviderCredentialProfile";
import { type ExistingWorktreeRef, gitExecLocal } from "@/lib/ipc/git";
import type { WorktreePlan } from "@/lib/scm/worktrees/worktreePlan";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import type { AccountProfile, Project, Provider } from "@/types";

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface CanonicalAddAgentRunInput {
	project: Project;
	agentName: string;
	provider: Provider;
	accountId: string | null;
	account?: AccountProfile;
	useWorktree: boolean;
	worktreePlan?: WorktreePlan;
	permissionOverride?: DureAgentRunPermissionOverrideV1;
	setupCommand: string | null;
	spaceId: string;
	windowLabel: string;
	existingCheckout?: ExistingWorktreeRef;
	prompt?: string;
	model?: string;
	effort?: string;
	/** The shared preference resolver pins Terminal unless Pro opts into Chat. */
	interactionPreference?: "native_cli";
	actionId: string;
	referencePanelId?: string;
	existingWorkspace?: {
		sourceAgentId: string;
		workspaceId: string;
		branch: string;
		executionProfile: AgentExecutionProfileV1;
		providerConversationRef: string | null;
		routeAuthority: DureBackendRouteAuthorityV1;
	};
}

export type CanonicalAddAgentRunPolicy = Omit<
	CanonicalAddAgentRunInput,
	"spaceId" | "windowLabel"
>;

export function supportsCanonicalAddAgentRun(
	input: CanonicalAddAgentRunPolicy,
): boolean {
	if (
		input.project.kind !== "local" ||
		(input.existingCheckout !== undefined &&
			(input.useWorktree ||
				input.existingWorkspace !== undefined ||
				input.setupCommand !== null)) ||
		(input.existingWorkspace !== undefined &&
			(input.useWorktree || input.setupCommand !== null)) ||
		(input.accountId === null && input.account !== undefined) ||
		(input.accountId !== null &&
			(!input.account ||
				input.account.id !== input.accountId ||
				input.account.provider !== input.provider ||
				!supportsDureProviderCredentialSpawn(input.provider))) ||
		(input.setupCommand !== null && !input.useWorktree)
	) {
		return false;
	}
	if (!input.useWorktree) return true;
	return (
		input.worktreePlan?.action === "create-new-branch" ||
		input.worktreePlan?.action === "checkout-existing-branch"
	);
}

async function resolveBaseCommit(
	projectPath: string,
	baseRef: string | undefined,
): Promise<string> {
	const revision = `${baseRef ?? "HEAD"}^{commit}`;
	const result = await gitExecLocal(projectPath, [
		"rev-parse",
		"--verify",
		revision,
	]);
	const commit = result.stdout.trim();
	if (result.code !== 0 || !GIT_OBJECT_ID.test(commit)) {
		throw new Error("agent_run_worktree_base_invalid");
	}
	return commit;
}

async function registerBackendProject(
	project: Project,
	routeAuthority: DureBackendRouteAuthorityV1,
): Promise<void> {
	const { promptDigest } = await computePromptIdentity(project.path);
	const request = createDureBackendRequester({
		profileId: routeAuthority.profileId,
		invalidResponseCode: "agent_run_response_invalid",
		invalidResponseMessage: t("ipc.dureRun.invalidResponse"),
		backendChangedCode: "agent_run_backend_changed",
		backendChangedMessage: t("ipc.dureBackend.generationChanged"),
		requestFailedCode: "agent_run_transport_failed",
		requestFailedMessage: t("ipc.dureRun.requestFailed"),
	});
	await request(
		"projects.register",
		{
			schemaVersion: 1,
			projectId: promptDigest.slice("sha256:".length),
			displayName: project.name,
			root: project.path,
		},
		{ kind: "exact", authority: routeAuthority },
	);
}

async function resolveCanonicalWorktree(
	input: CanonicalAddAgentRunPolicy,
): Promise<DureAgentRunWorktreeV1> {
	if (input.existingCheckout) {
		return {
			kind: "existing_checkout",
			reference: { ...input.existingCheckout },
		};
	}
	if (input.existingWorkspace) {
		return {
			kind: "existing_workspace",
			sourceAgentId: input.existingWorkspace.sourceAgentId,
			workspaceId: input.existingWorkspace.workspaceId,
		};
	}
	if (!input.useWorktree) return { kind: "project_root" };
	const plan = input.worktreePlan;
	return {
		kind: "dedicated",
		branch: plan?.branch ?? "",
		...(plan?.action === "checkout-existing-branch"
			? { branchMode: "existing" as const }
			: {}),
		...(plan?.worktreeRoot && plan.worktreeRoot !== ".worktrees/"
			? { checkoutPath: plan.worktreePath }
			: {}),
		baseCommitSha: await resolveBaseCommit(
			input.project.path,
			plan?.action === "checkout-existing-branch"
				? `refs/heads/${plan.branch}`
				: plan?.baseRef,
		),
	};
}

/** Single authority for the transport wire request shared by the pane and
 * background canonical runners. */
async function buildCanonicalRunRequest(
	input: CanonicalAddAgentRunPolicy,
	routeAuthority: DureBackendRouteAuthorityV1,
) {
	const executionProfile = input.account
		? await registerDureProviderCredentialProfile(
				{
					providerId: input.account.provider,
					referenceId: input.account.id,
					profileDirectoryName: providerAccountDirectoryName(input.account),
				},
				{
					profileId: routeAuthority.profileId,
					routeAuthority,
				},
			)
		: (input.existingWorkspace?.executionProfile ?? {
				kind: "provider_default" as const,
			});
	const worktree = await resolveCanonicalWorktree(input);
	return {
		projectPath: input.project.path,
		providerId: input.provider,
		executionProfile,
		agentName: input.agentName,
		worktree,
		...(input.existingWorkspace
			? {
					providerConversationRef:
						input.existingWorkspace.providerConversationRef,
				}
			: {}),
		...(input.permissionOverride
			? { permissionOverride: input.permissionOverride }
			: {}),
		...(input.setupCommand ? { setupCommand: input.setupCommand } : {}),
		...(input.prompt ? { prompt: input.prompt } : {}),
		...(input.model ? { model: input.model } : {}),
		...(input.effort ? { effort: input.effort } : {}),
		...(input.interactionPreference
			? { interactionPreference: input.interactionPreference }
			: {}),
		idempotencyKey: canonicalAddAgentRunIdempotencyKey(input.actionId),
	};
}

type CanonicalAgentRunRequest = Parameters<
	ReturnType<typeof createDureAgentRunTransport>["run"]
>[0];

/** One caller-owned action with every mutable launch input resolved exactly
 * once. Reusing this value retries the backend's immutable Run verbatim. */
export interface PreparedCanonicalAddAgentRun {
	readonly input: CanonicalAddAgentRunPolicy;
	readonly request: CanonicalAgentRunRequest;
	readonly routeAuthority: DureBackendRouteAuthorityV1;
}

export async function prepareCanonicalAddAgentRun(
	input: CanonicalAddAgentRunPolicy,
): Promise<PreparedCanonicalAddAgentRun> {
	// Own the submitted values before route or credential resolution can yield.
	input = structuredClone(input);
	const routeAuthority =
		input.existingWorkspace?.routeAuthority ??
		(await resolveSelectedDureBackendRouteAuthority("local"));
	return {
		input,
		routeAuthority,
		request: await buildCanonicalRunRequest(input, routeAuthority),
	};
}

function errorCode(cause: unknown): string | undefined {
	const candidate =
		typeof cause === "object" && cause !== null
			? (cause as { code?: unknown }).code
			: undefined;
	return typeof candidate === "string" ? candidate : undefined;
}

/** Only an explicitly recoverable result retains the caller's prepared action. */
export function shouldRetryCanonicalAddAgentAction(cause: unknown): boolean {
	if (typeof cause !== "object" || cause === null) return false;
	const details = (cause as { details?: unknown }).details;
	return (
		typeof details === "object" &&
		details !== null &&
		(details as { retry?: unknown }).retry === "same_intent"
	);
}

/** Runs the canonical transport request, admitting the project on demand:
 * registration happens only when the preview reports the project unknown,
 * then the run retries once. Registering unconditionally conflicts on
 * machines where the same root is already registered under another id
 * (CLI registrations, older runs) — resolvable projects must not pay a
 * registration round-trip at all. */
async function runAdmittedCanonicalRequest(
	project: Project,
	request: CanonicalAgentRunRequest,
	routeAuthority: DureBackendRouteAuthorityV1,
): Promise<DureAgentRunResultV1> {
	const transport = createDureAgentRunTransport();
	try {
		return await transport.run(request, routeAuthority);
	} catch (cause) {
		if (errorCode(cause) !== "agent_spawn_project_not_found") throw cause;
		try {
			await registerBackendProject(project, routeAuthority);
		} catch (registerCause) {
			// Losing the registration race (or the root already being owned by
			// another id) still means the path is resolvable now — the retry
			// below settles it by path. Anything else is a real failure.
			if (
				errorCode(registerCause) !== "backend_project_registration_conflict"
			) {
				throw registerCause;
			}
		}
		return await transport.run(request, routeAuthority);
	}
}

interface ExecutedCanonicalAddAgentRun {
	readonly run: DureAgentRunResultV1;
	readonly presentationWorktree: AgentRunPresentationWorktree;
}

async function executePreparedCanonicalAddAgentRun(
	prepared: PreparedCanonicalAddAgentRun,
): Promise<ExecutedCanonicalAddAgentRun> {
	const { input, request } = prepared;
	const existingWorkspace = input.existingWorkspace
		? {
				sourceAgentId: input.existingWorkspace.sourceAgentId,
				branch: input.existingWorkspace.branch,
			}
		: undefined;
	let run: DureAgentRunResultV1;
	try {
		run = await runAdmittedCanonicalRequest(
			input.project,
			request,
			prepared.routeAuthority,
		);
	} catch (cause) {
		if (
			errorCode(cause) !== "agent_run_backend_changed" &&
			errorCode(cause) !== "backend_transport_authority_changed" &&
			errorCode(cause) !== "backend_transport_generation_changed"
		) {
			throw cause;
		}
		const successor = await resolveSelectedDureBackendRouteAuthority(
			prepared.routeAuthority.profileId,
		);
		if (
			successor.backend.id !== prepared.routeAuthority.backend.id ||
			!sameDureBackendRouteTarget(
				successor.target,
				prepared.routeAuthority.target,
			)
		) {
			throw cause;
		}
		run = await runAdmittedCanonicalRequest(input.project, request, successor);
	}
	return {
		run,
		presentationWorktree: agentRunPresentationWorktree(
			run.worktree,
			existingWorkspace,
		),
	};
}

async function executeCanonicalAddAgentRun(
	input: CanonicalAddAgentRunPolicy,
): Promise<ExecutedCanonicalAddAgentRun> {
	return executePreparedCanonicalAddAgentRun(
		await prepareCanonicalAddAgentRun(input),
	);
}

export async function runCanonicalAddAgent(
	input: CanonicalAddAgentRunInput,
): Promise<DureAgentRunResultV1> {
	const { run, presentationWorktree } =
		await executeCanonicalAddAgentRun(input);
	const target = {
		projectPath: input.project.path,
		presentationWorktree,
		spaceId: input.spaceId,
		windowLabel: input.windowLabel,
		...(input.referencePanelId
			? { referencePanelId: input.referencePanelId }
			: {}),
	};
	if (run.interactionProfile === "structured_protocol") {
		await presentStructuredRun(run, target);
	} else {
		await presentManagedRun(localAgentRunPresentationRequest(run, target));
	}
	return run;
}

/** Same canonical Run as `runCanonicalAddAgent`, but presents the agent into
 * the store only — no pane, space mount, or attachment wait. Kept for callers
 * that must never touch the window (and as the fallback of
 * `runCanonicalAddAgentPresenting`). */
export async function runCanonicalAddAgentInBackground(
	input: CanonicalAddAgentRunPolicy & { prompt?: string; model?: string },
): Promise<DureAgentRunResultV1> {
	return (
		await runPreparedCanonicalAddAgentPresenting(
			await prepareCanonicalAddAgentRun(input),
			null,
		)
	).run;
}

/** Where a canonical run should open its pane: a space plus the window that
 * hosts it, both resolved at presentation time. */
export interface CanonicalRunPaneTarget {
	spaceId: string;
	windowLabel: string;
	referencePanelId?: string;
	position?: PanelPosition;
}

export interface CanonicalAddAgentPresentationResult {
	readonly run: DureAgentRunResultV1;
	readonly disposition: "pane" | "background";
}

class CanonicalAddAgentProjectionError extends Error {
	readonly code = "agent_run_projection_failed";
	readonly details: {
		readonly retry: "same_intent";
		readonly operationId: string;
		readonly agentId: string;
	};
	readonly projectionFailure: unknown;

	constructor(run: DureAgentRunResultV1, projectionFailure: unknown) {
		super(
			`agent_run_projection_failed: ${projectionFailure instanceof Error ? `${projectionFailure.name}: ${projectionFailure.message}` : String(projectionFailure)}`,
		);
		this.name = "CanonicalAddAgentProjectionError";
		this.details = {
			retry: "same_intent",
			operationId: run.operationId,
			agentId: run.agentId,
		};
		this.projectionFailure = projectionFailure;
	}
}

/** Canonical Run that opens the agent's pane in the target space. Any
 * presentation failure (window changed, space gone, attachment timeout)
 * falls back to the pane-less store projection so a pane problem can never
 * fail an already-successful spawn — the agent then appears in the Spaces
 * navigator's unopened list instead. Used by quick-dispatch. */
export async function runCanonicalAddAgentPresenting(
	input: CanonicalAddAgentRunPolicy,
	paneTarget: CanonicalRunPaneTarget | null,
): Promise<CanonicalAddAgentPresentationResult> {
	return runPreparedCanonicalAddAgentPresenting(
		await prepareCanonicalAddAgentRun(input),
		paneTarget,
	);
}

export async function runPreparedCanonicalAddAgentPresenting(
	prepared: PreparedCanonicalAddAgentRun,
	paneTarget: CanonicalRunPaneTarget | null,
): Promise<CanonicalAddAgentPresentationResult> {
	const { input } = prepared;
	const { run, presentationWorktree } =
		await executePreparedCanonicalAddAgentRun(prepared);
	if (paneTarget) {
		try {
			const target = {
				projectPath: input.project.path,
				presentationWorktree,
				spaceId: paneTarget.spaceId,
				windowLabel: paneTarget.windowLabel,
				...(paneTarget.position ? { position: paneTarget.position } : {}),
				...(paneTarget.referencePanelId
					? { referencePanelId: paneTarget.referencePanelId }
					: {}),
			};
			if (run.interactionProfile === "structured_protocol") {
				await presentStructuredRun(run, target);
			} else {
				await presentManagedRun(localAgentRunPresentationRequest(run, target));
			}
			return { run, disposition: "pane" };
		} catch (cause) {
			if (cause instanceof ManagedRunPaneCommittedError) {
				console.error(
					"[canonicalRun] pane committed; attachment confirmation failed",
					cause.attachmentFailure,
				);
				return { run, disposition: "pane" };
			}
			console.error(
				"[canonicalRun] pane presentation failed; falling back to the background projection",
				cause,
			);
		}
	}
	try {
		if (run.interactionProfile === "structured_protocol") {
			await presentStructuredRunInBackground(run, {
				projectPath: input.project.path,
				presentationWorktree,
			});
		} else {
			await presentManagedRunInBackground(run, {
				projectPath: input.project.path,
				presentationWorktree,
			});
		}
	} catch (cause) {
		throw new CanonicalAddAgentProjectionError(run, cause);
	}
	return { run, disposition: "background" };
}
