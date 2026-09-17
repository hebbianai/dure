import { describe, expect, it, vi } from "vitest";
import {
	LargeViewReturnSourceCoordinator,
	parseLargeViewSourcePaneOwnerId,
} from "./largeViewReturnSourceCoordinator";

const request = {
	workspaceId: "workspace-1",
	sessionId: "session-1",
	sourcePaneOwnerId: "desktop-source:agent:1",
	generation: "return-1",
	expiresAtMs: 2_000,
};

describe("LargeViewReturnSourceCoordinator", () => {
	it("activates an inactive exact desktop and pane before concealment", async () => {
		let activeSpaceId = "desktop-other";
		let activePanelId = "agent:other";
		const prepare = vi.fn(() => {
			expect(activeSpaceId).toBe("desktop-source");
			expect(activePanelId).toBe("agent:1");
			return true;
		});
		const coordinator = new LargeViewReturnSourceCoordinator(
			(paneOwnerId) => {
				const target = parseLargeViewSourcePaneOwnerId(paneOwnerId);
				if (!target) return false;
				activeSpaceId = target.desktopId;
				activePanelId = target.panelId;
				return true;
			},
			{
				now: () => 1_000,
				setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
				clearTimer: (timer) => clearTimeout(timer),
			},
		);
		coordinator.register({
			workspaceId: request.workspaceId,
			sessionId: request.sessionId,
			sourcePaneOwnerId: request.sourcePaneOwnerId,
			legacyEligible: () => false,
			prepare,
		});

		await expect(coordinator.prepare(request)).resolves.toBe(true);
		expect(prepare).toHaveBeenCalledWith("return-1");
	});

	it("waits for an exact source terminal to mount after desktop activation", async () => {
		const prepare = vi.fn(() => true);
		const coordinator = new LargeViewReturnSourceCoordinator(() => true, {
			now: () => 1_000,
			setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
			clearTimer: (timer) => clearTimeout(timer),
		});
		const pending = coordinator.prepare(request);

		coordinator.register({
			workspaceId: request.workspaceId,
			sessionId: request.sessionId,
			sourcePaneOwnerId: request.sourcePaneOwnerId,
			legacyEligible: () => false,
			prepare,
		});

		await expect(pending).resolves.toBe(true);
		expect(prepare).toHaveBeenCalledWith("return-1");
	});

	it("keeps legacy fallback on the already eligible source without navigation", async () => {
		const activate = vi.fn(() => true);
		const hiddenPrepare = vi.fn(() => true);
		const visiblePrepare = vi.fn(() => true);
		const coordinator = new LargeViewReturnSourceCoordinator(activate, {
			now: () => 1_000,
			setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
			clearTimer: (timer) => clearTimeout(timer),
		});
		coordinator.register({
			workspaceId: request.workspaceId,
			sessionId: request.sessionId,
			sourcePaneOwnerId: "desktop-hidden:agent:1",
			legacyEligible: () => false,
			prepare: hiddenPrepare,
		});
		coordinator.register({
			workspaceId: request.workspaceId,
			sessionId: request.sessionId,
			sourcePaneOwnerId: "desktop-visible:agent:1",
			legacyEligible: () => true,
			prepare: visiblePrepare,
		});

		await expect(
			coordinator.prepare({ ...request, sourcePaneOwnerId: undefined }),
		).resolves.toBe(true);
		expect(activate).not.toHaveBeenCalled();
		expect(hiddenPrepare).not.toHaveBeenCalled();
		expect(visiblePrepare).toHaveBeenCalledOnce();
	});

	it("routes retirement to the exact registration with its generation intact", async () => {
		const retired = vi.fn();
		let preparedGeneration: string | undefined;
		const coordinator = new LargeViewReturnSourceCoordinator(() => true, {
			now: () => 1_000,
			setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
			clearTimer: (timer) => clearTimeout(timer),
		});
		coordinator.register({
			workspaceId: request.workspaceId,
			sessionId: request.sessionId,
			sourcePaneOwnerId: request.sourcePaneOwnerId,
			legacyEligible: () => false,
			prepare: (generation) => {
				preparedGeneration = generation;
				return true;
			},
			retired: (generation) => {
				if (generation === preparedGeneration) retired(generation);
			},
		});
		await expect(coordinator.prepare(request)).resolves.toBe(true);

		coordinator.retired({ ...request, generation: "return-wrong" });
		expect(retired).not.toHaveBeenCalled();
		coordinator.retired(request);
		expect(retired).toHaveBeenCalledOnce();
		expect(retired).toHaveBeenCalledWith("return-1");
	});
});

describe("parseLargeViewSourcePaneOwnerId", () => {
	it("preserves colons inside a panel id", () => {
		expect(parseLargeViewSourcePaneOwnerId("desktop-2:agent:agent-1")).toEqual({
			desktopId: "desktop-2",
			panelId: "agent:agent-1",
		});
	});
});
