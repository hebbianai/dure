import { agentRuntimeWorkspaceRepairMatches } from "@/lib/agents/agentRuntimeReplacementTarget";
import { projectAgentRuntimeTransition } from "@/lib/agents/agentRuntimeStoreProjector";
import {
	observeAgentRuntimeAction,
	transitionAgentRuntime,
} from "@/lib/agents/agentRuntimeTransitionAction";
import {
	type AgentProjectMovePlan,
	createAgentProjectMoveClient,
} from "@/lib/ipc/dureAgentProjectMove";
import {
	createDureAgentRuntimeClient,
	type DureAgentRuntimeProjectionInspectResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import { sameDureBackendRouteTarget } from "@/lib/ipc/dureBackendRoute";
import { convergeManagedAgentRehost } from "@/lib/sessions/managed/managedAgentRehostConvergence";
import { useStore } from "@/store";

/** A local refusal is known not to have submitted the reviewed operation. */
class AgentProjectMovePreparationError extends Error {
	readonly submitted = false;
	constructor(readonly code: string) {
		super(code);
	}
}

/** The backend journal owns recovery. A dialog keeps only its reviewed request. */
export async function prepareAgentProjectMove(agentId: string) {
	const rehost = convergeManagedAgentRehost(agentId, `agent:${agentId}`);
	await rehost.catch(() => null);
	let conversation: string | null | undefined;
	const {
		client: runtime,
		observation: source,
		checkpoint,
	} = await observeAgentRuntimeAction(
		agentId,
		(value) => {
			if (conversation !== undefined && value !== conversation)
				throw new AgentProjectMovePreparationError(
					"client_project_move_preview_stale",
				);
			conversation = value;
		},
		rehost,
	);
	const pending =
		source.state === "repair_required" || source.state === "transitioning"
			? await runtime.inspectTransitionIntent(source)
			: undefined;
	const recoveredPlan = pending?.workspaceMovePlan;
	const sourceRevision =
		source.state === "stable"
			? source.selectionRevision
			: source.state === "closed" && source.stage === "stopped"
				? source.source?.selectionRevision
				: recoveredPlan?.source.revision;
	if (sourceRevision === undefined)
		throw new AgentProjectMovePreparationError(
			"client_project_move_source_unavailable",
		);
	const assertInputPreserved = () => {
		const current = useStore
			.getState()
			.agents.find((candidate) => candidate.id === agentId);
		if (!current || current.pendingCmd || current.pendingCredentialSwitch)
			throw new AgentProjectMovePreparationError(
				"client_project_move_pending_input",
			);
	};
	const preDispatch = () => {
		try {
			checkpoint();
			assertInputPreserved();
		} catch (error) {
			throw error instanceof AgentProjectMovePreparationError
				? error
				: new AgentProjectMovePreparationError(
						"client_project_move_preview_stale",
					);
		}
	};
	const authority = source.routeAuthority;
	const client = createAgentProjectMoveClient({
		profileId: source.backendProfileId,
	});
	// Recovery does not depend on a projects-list request or the user's current selection.
	const { projects, complete } = recoveredPlan
		? { projects: [], complete: true }
		: await client.projects(authority);
	let attempted = !!recoveredPlan;
	// A fresh reader may observe a new generation, but cannot retarget this owner.
	const inspect = async () => {
		const readAuthority = await resolveSelectedDureBackendRouteAuthority(
			source.backendProfileId,
		);
		if (
			readAuthority.profileId !== authority.profileId ||
			readAuthority.backend.id !== authority.backend.id ||
			!sameDureBackendRouteTarget(readAuthority.target, authority.target)
		)
			throw new Error("client_project_move_backend_changed");
		return createDureAgentRuntimeClient({
			profileId: source.backendProfileId,
		}).inspectExact(agentId, readAuthority);
	};

	const isCompleted = (
		plan: AgentProjectMovePlan,
		observed: DureAgentRuntimeProjectionInspectResultV1,
	) =>
		observed.state === "stable" &&
		observed.agentId === plan.source.agentId &&
		observed.providerId === plan.source.providerId &&
		observed.interactionProfile === plan.targetInteractionProfile &&
		(observed.interactionProfile !== "structured_protocol" ||
			observed.interactionSessionId ===
				plan.sourceAuthority?.binding?.interactionSessionId) &&
		observed.providerConversationRef === plan.providerConversationRef &&
		observed.selectionRevision === plan.source.revision + 1 &&
		observed.projectionContext?.workspaceMove?.operationId ===
			plan.operationId &&
		observed.projectionContext.workspace.workspaceId ===
			plan.workspaceMove.targetWorkspace.workspaceId &&
		observed.projectionContext.workspace.projectId ===
			plan.workspaceMove.targetWorkspace.projectId &&
		observed.projectionContext.workspace.rootPath ===
			plan.workspaceMove.targetWorkspace.rootPath;
	const observeCompleted = async (plan: AgentProjectMovePlan) => {
		const observed = await inspect();
		if (!isCompleted(plan, observed) || observed.state !== "stable")
			throw new Error("client_project_move_unconfirmed");
		projectAgentRuntimeTransition(agentId, observed);
	};
	return {
		projects,
		complete,
		recoveredPlan,
		recoveredStatus: pending?.state,
		async preview(projectId: string) {
			preDispatch();
			const plan = await client.preview(agentId, projectId, authority);
			if (
				plan.source.revision !== sourceRevision ||
				(conversation != null && plan.providerConversationRef !== conversation)
			)
				throw new AgentProjectMovePreparationError(
					"client_project_move_preview_stale",
				);
			return plan;
		},
		async status(plan: AgentProjectMovePlan) {
			const observed = await inspect();
			if (
				observed.state === "stable" &&
				(isCompleted(plan, observed) ||
					agentRuntimeWorkspaceRepairMatches(plan, observed))
			) {
				projectAgentRuntimeTransition(agentId, observed);
				return "completed" as const;
			}
			if (
				(observed.state === "repair_required" ||
					observed.state === "transitioning") &&
				observed.operationId === plan.operationId
			)
				return observed.state === "repair_required"
					? ("repair_required" as const)
					: ("unconfirmed" as const);
			if (
				(observed.state === "stable" &&
					observed.selectionRevision === plan.source.revision &&
					observed.providerConversationRef === plan.providerConversationRef) ||
				(observed.state === "closed" &&
					observed.stage === "stopped" &&
					observed.source?.selectionRevision === plan.source.revision)
			)
				return "not_submitted" as const;
			return "unconfirmed" as const;
		},
		async repair(plan: AgentProjectMovePlan) {
			preDispatch();
			const observed = await inspect();
			if (
				observed.state !== "repair_required" ||
				observed.operationId !== plan.operationId
			)
				throw new Error("client_project_move_unconfirmed");
			// Reuse runtime repair/reconciliation, including a lost repair response.
			// Its beforeTransition check runs after all awaited repair preparation.
			preDispatch();
			await transitionAgentRuntime({
				agentId,
				targetInteractionProfile: plan.targetInteractionProfile,
				expectedSourceRevision: plan.source.revision,
				expectedConversationId: plan.providerConversationRef,
				expectedOperationId: plan.operationId,
				expectedRouteAuthority: observed.routeAuthority,
				beforeTransition: preDispatch,
			});
		},
		async apply(plan: AgentProjectMovePlan) {
			preDispatch();
			let mutationAuthority = authority;
			if (attempted) {
				const observed = await inspect();
				if (isCompleted(plan, observed) && observed.state === "stable") {
					projectAgentRuntimeTransition(agentId, observed);
					return;
				}
				// Only an exact admitted journal can authorize resuming this request
				// on a refreshed route. Unknown outcomes never mint another operation.
				if (
					observed.state !== "transitioning" ||
					observed.stage !== "admitted" ||
					observed.operationId !== plan.operationId
				)
					throw new Error("client_project_move_unconfirmed");
				mutationAuthority = observed.routeAuthority;
				preDispatch();
			}
			attempted = true;
			try {
				await client.apply(plan, mutationAuthority);
			} catch (error) {
				try {
					await observeCompleted(plan);
					return;
				} catch {
					throw error;
				}
			}
			await observeCompleted(plan);
		},
	};
}
