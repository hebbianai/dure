// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableProjectionDepartures } from "@/lib/persistence/durableProjectionRuntimeCleanup";

vi.mock("@/lib/persistence/durableAppStateSettlement", () => ({
	settleDurableAppState: vi.fn(),
}));
vi.mock("@/lib/platform/pageReload", () => ({ reloadCurrentPage: vi.fn() }));
vi.mock("@/store", () => ({
	durableAppStorage: { freezeProjectionAncestor: vi.fn(() => vi.fn()) },
}));

import { settleDurableAppState } from "@/lib/persistence/durableAppStateSettlement";
import { recoverCurrentDurableStoreProjection } from "@/lib/persistence/currentDurableProjectionRecovery";
import {
	type DurableStoreProjectionError,
	rehydrateDurableStore,
	subscribeDurableStoreLayoutProjection,
} from "@/lib/persistence/durableStoreRehydration";
import { reloadCurrentPage } from "@/lib/platform/pageReload";

const settle = vi.mocked(settleDurableAppState);
const subscriptions: Array<() => void> = [];

function removedReferences(
	paneOccurrences: readonly string[] = [],
	projectionSpaceIds: readonly string[] =
		paneOccurrences.length > 0 ? ["space-1"] : [],
): DurableProjectionDepartures {
	return {
		agentIds: new Set(),
		projectIds: new Set(),
		sessionIds: new Set(),
		paneOccurrences: new Set(paneOccurrences),
		projectionSpaceIds: new Set(projectionSpaceIds),
	};
}

afterEach(() => {
	for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
	vi.clearAllMocks();
});

describe("rehydrateDurableStore", () => {
	it("forces mounted projection when rehydrate removes a pane occurrence", async () => {
		settle.mockResolvedValue(removedReferences(["removed-pane"]));
		const project = vi.fn(() => true);
		const unrelatedProject = vi.fn(() => true);
		subscriptions.push(
			subscribeDurableStoreLayoutProjection("space-1", project, () => true),
			subscribeDurableStoreLayoutProjection(
				"space-2",
				unrelatedProject,
				() => true,
			),
		);

		await rehydrateDurableStore();

		expect(project).toHaveBeenCalledOnce();
		expect(unrelatedProject).not.toHaveBeenCalled();
	});

	it("forces mounted projection for a changed layout without cleanup departures", async () => {
		settle.mockResolvedValue(removedReferences([], ["space-1"]));
		const project = vi.fn(() => true);
		subscriptions.push(
			subscribeDurableStoreLayoutProjection("space-1", project, () => true),
		);

		await rehydrateDurableStore();

		expect(project).toHaveBeenCalledOnce();
	});

	it("reports a failed required mounted projection", async () => {
		settle.mockResolvedValue(removedReferences());
		subscriptions.push(
			subscribeDurableStoreLayoutProjection(
				"space-1",
				() => false,
				() => true,
			),
		);

		await expect(
			rehydrateDurableStore({ forceProjectionDesktopIds: ["space-1"] }),
		).rejects.toEqual(
			expect.objectContaining<Partial<DurableStoreProjectionError>>({
				desktopIds: ["space-1"],
			}),
		);
	});

	it("forces the same consumed projection target during recovery", async () => {
		settle
			.mockResolvedValueOnce(removedReferences(["removed-pane"]))
			.mockResolvedValueOnce(removedReferences());
		const project = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
		subscriptions.push(
			subscribeDurableStoreLayoutProjection("space-1", project, () => true),
		);

		await expect(recoverCurrentDurableStoreProjection()).resolves.toBe(true);

		expect(project).toHaveBeenCalledTimes(2);
		expect(reloadCurrentPage).not.toHaveBeenCalled();
	});

	it("retries only failed mounted desktops after a global forced projection", async () => {
		settle
			.mockResolvedValueOnce(removedReferences([], ["space-1"]))
			.mockResolvedValueOnce(removedReferences());
		const failedThenRecovered = vi
			.fn()
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true);
		const projectedOnce = vi.fn(() => true);
		subscriptions.push(
			subscribeDurableStoreLayoutProjection(
				"space-1",
				projectedOnce,
				() => true,
			),
			subscribeDurableStoreLayoutProjection(
				"space-2",
				failedThenRecovered,
				() => true,
			),
		);

		await expect(
			recoverCurrentDurableStoreProjection({ forceProjection: true }),
		).resolves.toBe(true);

		expect(failedThenRecovered).toHaveBeenCalledTimes(2);
		expect(projectedOnce).toHaveBeenCalledOnce();
		expect(reloadCurrentPage).not.toHaveBeenCalled();
	});

	it("keeps focused mounted layouts untouched when durable panes did not depart", async () => {
		settle.mockResolvedValue(removedReferences());
		const project = vi.fn(() => true);
		subscriptions.push(
			subscribeDurableStoreLayoutProjection("space-1", project, () => true),
		);

		await rehydrateDurableStore();

		expect(project).not.toHaveBeenCalled();
	});
});
