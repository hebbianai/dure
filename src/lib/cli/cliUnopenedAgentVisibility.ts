import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { isUnopenedAgentHidden } from "@/lib/spaces/unopenedAgentVisibility";
import {
	unopenedAgentVisibilityStorage,
	useUnopenedAgentVisibilityStore,
} from "@/lib/spaces/unopenedAgentVisibilityStore";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { agentPaneLocations } from "@/lib/workspace/layout/agentPaneLocations";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { useStore } from "@/store";

interface VisibilityRequest {
	agentId: string;
	operation: "get" | "hide" | "restore";
	expectedEpisode?: number;
}

class VisibilityError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function parseRequest(params: Record<string, unknown>): VisibilityRequest {
	const { agentId, operation, expectedEpisode } = params;
	if (
		params.schemaVersion !== 1 ||
		typeof agentId !== "string" ||
		!agentId.trim() ||
		agentId !== agentId.trim() ||
		agentId.length > 512 ||
		[...agentId].some((char) => char.charCodeAt(0) < 32 || char === "\x7f") ||
		(operation !== "get" && operation !== "hide" && operation !== "restore") ||
		(operation === "get"
			? expectedEpisode !== undefined
			: !Number.isSafeInteger(expectedEpisode) || Number(expectedEpisode) < 0)
	) {
		throw new VisibilityError(
			"invalid_request",
			"An exact agent ID and a valid visibility observation are required.",
		);
	}
	return {
		agentId,
		operation,
		expectedEpisode: expectedEpisode as number | undefined,
	};
}

function observation(agentId: string) {
	const state = useStore.getState();
	if (!state.agents.some((agent) => agent.id === agentId)) {
		throw new VisibilityError(
			"agent_not_found",
			"The exact registered agent no longer exists.",
		);
	}
	const placement = Object.getOwnPropertyDescriptor(
		useHiddenPanes.getState().hidden,
		agentId,
	)
		? "hidden_pane"
		: agentPaneLocations(state.layouts, mountedDockviewEntries()).some(
					(pane) => pane.agentId === agentId,
				)
			? "placed"
			: "unopened";
	const episode = useAgentAttention.getState().episodes[agentId] ?? 0;
	return {
		agentId,
		placement,
		episode,
		hidden: isUnopenedAgentHidden(
			{ id: agentId, episode },
			useUnopenedAgentVisibilityStore.getState().hidden,
		),
	};
}

interface VisibilityDependencies {
	claim(reqId: string): Promise<boolean>;
	complete(reqId: string, result: unknown, action: string): Promise<unknown>;
	isMainWindow(): boolean;
}

/** Reuse Hide from list's presentation owner; no runtime or removal authority. */
export async function dispatchCliUnopenedAgentVisibility(
	request: { reqId: string; action: string; params: Record<string, unknown> },
	dependencies: VisibilityDependencies,
): Promise<boolean> {
	if (request.action !== "agents.unopened.visibility") return false;
	if (
		!dependencies.isMainWindow() ||
		!(await dependencies.claim(request.reqId))
	)
		return true;
	let result: unknown;
	try {
		const { agentId, operation, expectedEpisode } = parseRequest(
			request.params,
		);
		if (
			!useStore.persist.hasHydrated() ||
			!useHiddenPanes.persist.hasHydrated() ||
			!useUnopenedAgentVisibilityStore.persist.hasHydrated()
		) {
			throw new VisibilityError(
				"client_not_ready",
				"Agent visibility has not hydrated yet.",
			);
		}
		const before = observation(agentId);
		if (operation !== "get" && expectedEpisode !== before.episode) {
			throw new VisibilityError(
				"visibility_observation_stale",
				"Agent attention changed; get its current visibility before deciding again.",
			);
		}
		const store = useUnopenedAgentVisibilityStore.getState();
		let changed = false;
		if (operation === "hide") {
			if (before.placement !== "unopened") {
				throw new VisibilityError(
					"agent_not_unopened",
					"Placed and hidden panes cannot be hidden from the unopened list.",
				);
			}
			changed = !before.hidden;
			if (changed) store.hide({ id: agentId, episode: before.episode });
		} else if (operation === "restore") {
			changed = store.hidden.some((record) => record.id === agentId);
			if (changed) store.restore(agentId);
		}
		await unopenedAgentVisibilityStorage.flush();
		// Fresh attention during persistence still resurfaces the row. Report
		// the actual observation, not the requested state or an earlier sample.
		result = {
			ok: true,
			visibility: {
				schemaVersion: 1,
				...observation(agentId),
				changed,
				persisted: true,
			},
		};
	} catch (error) {
		result = {
			ok: false,
			error: {
				code:
					error instanceof VisibilityError
						? error.code
						: "unopened_visibility_failed",
				message:
					error instanceof Error
						? error.message
						: "Visibility update failed; inspect its current state before another change.",
			},
		};
	}
	await dependencies.complete(request.reqId, result, request.action);
	return true;
}
