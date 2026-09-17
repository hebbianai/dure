import { describe, expect, it } from "vitest";
import {
	normalizePersistedState,
	type PersistedAppState,
} from "@/lib/persistence/persistedAppState";
import { convergePersistedAppState } from "@/lib/persistence/persistedAppStateConvergence";
import {
	panelIsPlacedInLayout,
	panelsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import type { SshHostConfig } from "@/types";

function appState(patch: Partial<PersistedAppState>): PersistedAppState {
	return {
		...normalizePersistedState({}),
		spaces: [{ id: "space-a", name: "Main" }],
		...patch,
	};
}

function layout(
	panelId?: string,
	options: { readonly place?: boolean; readonly hostId?: string } = {},
): Record<string, unknown> {
	const placed = panelId !== undefined && options.place !== false;
	return {
		grid: {
			root: {
				type: "branch",
				data: placed
					? [
							{
								type: "leaf",
								data: {
									id: `group:${panelId}`,
									views: [panelId],
									activeView: panelId,
								},
								size: 300,
							},
						]
					: [],
				size: 400,
			},
			width: 600,
			height: 400,
			orientation: "HORIZONTAL",
		},
		panels:
			panelId === undefined
				? {}
				: {
						[panelId]: {
							id: panelId,
							params: options.hostId ? { hostId: options.hostId } : {},
						},
					},
		...(placed ? { activeGroup: `group:${panelId}` } : {}),
	};
}

describe("semantic pane placement authority", () => {
	it.each(["successor-first", "removal-first"] as const)(
		"does not resurrect an unplaced SSH pane definition (%s)",
		(order) => {
			const source: SshHostConfig = {
				id: "host-a",
				name: "Host",
				host: "source.example.test",
				port: 22,
				user: "dure",
				auth: "auto",
			};
			const successor = { ...source, host: "successor.example.test" };
			const paneId = "ssh:orphan";
			const base = appState({
				sshHosts: [source],
				layouts: {
					"space-a": layout(paneId, { hostId: source.id }),
				},
			});
			const changedHostWithOrphanDefinition = {
				...base,
				sshHosts: [successor],
				layouts: {
					"space-a": layout(paneId, {
						hostId: source.id,
						place: false,
					}),
				},
			};
			const removed = {
				...base,
				sshHosts: [],
				layouts: { "space-a": layout() },
			};

			const merged =
				order === "successor-first"
					? convergePersistedAppState(
							base,
							changedHostWithOrphanDefinition,
							removed,
						)
					: convergePersistedAppState(
							base,
							removed,
							changedHostWithOrphanDefinition,
						);
			const mergedLayout = merged.layouts["space-a"];

			expect(merged.sshHosts).toEqual([successor]);
			expect(panelIsPlacedInLayout(mergedLayout, paneId)).toBe(false);
			expect(panelsFromLayout(mergedLayout)).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ id: paneId })]),
			);
		},
	);
});
