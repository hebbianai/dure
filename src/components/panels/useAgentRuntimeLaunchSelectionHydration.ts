import { useCallback, useEffect, useMemo, useState } from "react";
import type { StructuredAgentRuntimeProjectionSourceV1 } from "@/lib/agents/agentRuntimeProjectionRecovery";
import type {
	RecoveredStructuredAgentRuntimeProjection,
	StructuredAgentRuntimeProjectionRecoveryRequestV1,
} from "@/lib/agents/agentRuntimeStructuredProjectionRecovery";
import type { DureProviderPermissionModeV1 } from "@/lib/ipc/dureAgentRuntime";
import { useStore } from "@/store";

export interface AgentRuntimeLaunchState {
	loaded: boolean;
	hydrationError: boolean;
	model: string | null;
	effort: string | null;
	permissionMode: DureProviderPermissionModeV1;
	ownerKey: string | null;
	selectionRevision: number;
}

interface AgentRuntimeLaunchSelectionHydrationOptions {
	agentId: string;
	ownerKey: string | null;
	backendProfileId?: string;
	interactionSessionId?: string;
	isCurrentSource: (
		agentId: string,
		backendProfileId: string,
		interactionSessionId: string,
	) => boolean;
	recoverRuntimeProjection: (
		source: StructuredAgentRuntimeProjectionSourceV1,
		request: StructuredAgentRuntimeProjectionRecoveryRequestV1,
	) => Promise<RecoveredStructuredAgentRuntimeProjection | undefined>;
}

const initialLaunchState: AgentRuntimeLaunchState = {
	loaded: false,
	hydrationError: false,
	model: null,
	effort: null,
	permissionMode: "default",
	ownerKey: null,
	selectionRevision: -1,
};

export function useAgentRuntimeLaunchSelectionHydration({
	agentId,
	ownerKey,
	backendProfileId,
	interactionSessionId,
	isCurrentSource,
	recoverRuntimeProjection,
}: AgentRuntimeLaunchSelectionHydrationOptions) {
	const [storedLaunchState, setLaunchState] =
		useState<AgentRuntimeLaunchState>(initialLaunchState);
	const [hydrationAttempt, setHydrationAttempt] = useState(0);
	const committedPresentation = useStore(
		(state) => state.agentRuntimeLaunchPresentation[agentId],
	);
	const projectedLaunchState = useMemo<
		AgentRuntimeLaunchState | undefined
	>(() => {
		if (committedPresentation?.ownerKey !== ownerKey) return undefined;
		return {
			loaded: true,
			hydrationError: false,
			...committedPresentation.launchSelection,
			ownerKey,
			selectionRevision: committedPresentation.selectionRevision,
		};
	}, [committedPresentation, ownerKey]);

	useEffect(() => {
		if (projectedLaunchState) {
			setLaunchState((state) =>
				state.ownerKey === ownerKey &&
				state.selectionRevision >= projectedLaunchState.selectionRevision
					? state
					: projectedLaunchState,
			);
		}
		if (!backendProfileId || !interactionSessionId) {
			setLaunchState((state) =>
				state.ownerKey === ownerKey
					? state
					: { ...initialLaunchState, ownerKey },
			);
		}
	}, [backendProfileId, interactionSessionId, ownerKey, projectedLaunchState]);

	useEffect(() => {
		if (!backendProfileId || !interactionSessionId) return;
		let current = true;
		const recovery = new AbortController();
		const launchBoundary =
			useStore.getState().agentRuntimeLaunchPresentation[agentId];
		setLaunchState((state) =>
			state.ownerKey === ownerKey
				? { ...state, hydrationError: false }
				: {
						...state,
						loaded: false,
						hydrationError: false,
						ownerKey,
					},
		);
		void recoverRuntimeProjection(
			{
				agentId,
				backendProfileId,
				interactionSessionId,
			},
			{ kind: "initial_attach", signal: recovery.signal },
		)
			.then((projection) => {
				if (
					!current ||
					!isCurrentSource(agentId, backendProfileId, interactionSessionId)
				) {
					return;
				}
				if (!projection) {
					setLaunchState((state) =>
						state.ownerKey === ownerKey && !state.hydrationError
							? state
							: { ...state, hydrationError: false, ownerKey },
					);
					return;
				}
				setLaunchState((state) =>
					state.loaded &&
					state.ownerKey === projection.ownerKey &&
					state.selectionRevision >= projection.selectionRevision
						? state
						: {
								loaded: true,
								hydrationError: false,
								...projection.launchSelection,
								ownerKey: projection.ownerKey,
								selectionRevision: projection.selectionRevision,
							},
				);
			})
			.catch(() => {
				if (
					!current ||
					!isCurrentSource(agentId, backendProfileId, interactionSessionId) ||
					useStore.getState().agentRuntimeLaunchPresentation[agentId] !==
						launchBoundary
				) {
					return;
				}
				setLaunchState((state) =>
					state.ownerKey === ownerKey
						? { ...state, hydrationError: true }
						: {
								...initialLaunchState,
								hydrationError: true,
								ownerKey,
							},
				);
			});
		return () => {
			current = false;
			recovery.abort();
		};
	}, [
		agentId,
		backendProfileId,
		hydrationAttempt,
		interactionSessionId,
		isCurrentSource,
		ownerKey,
		recoverRuntimeProjection,
	]);

	const retryHydration = useCallback(
		() => setHydrationAttempt((attempt) => attempt + 1),
		[],
	);

	const launchState = projectedLaunchState
		? storedLaunchState.ownerKey === ownerKey &&
			storedLaunchState.selectionRevision >=
				projectedLaunchState.selectionRevision
			? storedLaunchState
			: projectedLaunchState
		: storedLaunchState.ownerKey === ownerKey
			? storedLaunchState
			: { ...initialLaunchState, ownerKey };
	return { launchState, setLaunchState, retryHydration };
}
