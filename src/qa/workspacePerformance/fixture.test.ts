import { describe, expect, test } from "vitest";
import { DEFAULT_UI_PREFS } from "@/lib/settings/uiPrefs";
import {
	buildWorkspacePerformanceFixture,
	type WorkspacePerformanceFixtureSession,
	workspacePerformanceFixtureState,
} from "./fixture";
import { workspacePerformanceScenario } from "./scenario";

const scenario = workspacePerformanceScenario("baseline_15");

const stopFence = {
	runnerPrincipal: "runner",
	runnerInstance: "instance",
	channelEpoch: "1",
	hostInstanceId: "host",
	terminalEpoch: "1",
};

function session(
	desktop: number,
	pane: number,
): WorkspacePerformanceFixtureSession {
	const provider = (desktop + pane) % 2 === 0 ? "claude" : "codex";
	return {
		provider,
		desktop,
		pane,
		cwd: "/tmp",
		session: {
			sessionId: `session-${desktop}-${pane}`,
			workspaceId: `workspace-${desktop}-${pane}`,
			sessionClass: "managed",
			lifecycle: "ready",
			terminalEpoch: "1",
			stopFence,
			outputSeq: "0",
			capabilities: [],
		},
	};
}

function sessionsFor(
	definition: Pick<typeof scenario, "desktopCount" | "panesPerDesktop">,
) {
	return Array.from({ length: definition.desktopCount }, (_, desktop) =>
		Array.from({ length: definition.panesPerDesktop }, (_, pane) =>
			session(desktop + 1, pane + 1),
		),
	).flat();
}

const sessions = () => sessionsFor(scenario);

describe("workspace performance fixture", () => {
	test("builds five deterministic three-terminal workspaces", () => {
		const fixture = buildWorkspacePerformanceFixture(
			sessions().reverse(),
			scenario,
		);

		expect(fixture.spaces).toHaveLength(5);
		expect(fixture.activeSpaceId).toBe("qa-performance-1");
		expect(fixture.panelIdsByDesktop["qa-performance-1"]).toEqual([
			"term:session-1-1",
			"term:session-1-2",
			"term:session-1-3",
		]);
		expect(fixture.sessionAgent["session-1-1"]).toBe("claude");
		expect(fixture.sessionAgent["session-1-2"]).toBe("codex");
	});

	test("uses exact managed bindings in persisted Dockview layouts", () => {
		const fixture = buildWorkspacePerformanceFixture(sessions(), scenario);
		const layout = fixture.layouts["qa-performance-2"] as {
			grid: {
				width: number;
				height: number;
				root: { size: number; data: Array<{ size: number }> };
			};
			activeGroup: string;
			panels: Record<string, { params: Record<string, unknown> }>;
		};

		expect(layout.grid).toMatchObject({
			width: 1200,
			height: 800,
			root: {
				size: 800,
				data: [{ size: 400 }, { size: 400 }, { size: 400 }],
			},
		});
		expect(layout.activeGroup).toBe("group:term:session-2-1");
		expect(layout.panels["term:session-2-1"].params.binding).toEqual({
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			sessionId: "session-2-1",
			workspaceId: "workspace-2-1",
			createIdempotencyKey: "session-2-1",
			stopFence,
		});
	});

	test("keeps multi-digit desktop identities aligned in scale fixtures", () => {
		const scale = workspacePerformanceScenario("scale_30");
		const fixture = buildWorkspacePerformanceFixture(sessionsFor(scale), scale);

		expect(fixture.panelIdsByDesktop["qa-performance-10"]).toEqual([
			"term:session-10-1",
			"term:session-10-2",
			"term:session-10-3",
		]);
	});

	test("keeps first-run onboarding out of the measured terminal workspace", () => {
		const fixture = buildWorkspacePerformanceFixture(sessions(), scenario);
		const state = workspacePerformanceFixtureState(fixture, DEFAULT_UI_PREFS);

		expect(state.uiPrefs).toMatchObject({
			tabOrder: "manual",
			onboardingDismissed: true,
		});
		expect(state.sessionTitle["session-1-1"]).toBe("Claude Code");
	});

	test("fails closed on incomplete or non-ready session sets", () => {
		expect(() =>
			buildWorkspacePerformanceFixture(sessions().slice(1), scenario),
		).toThrow("requires 15 sessions, found 14");
		const invalid = sessions();
		invalid[0] = {
			...invalid[0],
			session: { ...invalid[0].session, lifecycle: "exited" },
		};
		expect(() => buildWorkspacePerformanceFixture(invalid, scenario)).toThrow(
			"session is not ready",
		);
	});

	test("fails closed on duplicate topology cells", () => {
		const duplicate = sessions();
		duplicate[14] = {
			...duplicate[14],
			desktop: 1,
			pane: 1,
			session: {
				...duplicate[14].session,
				sessionId: "another-session",
			},
		};
		expect(() => buildWorkspacePerformanceFixture(duplicate, scenario)).toThrow(
			"fixture has a duplicate: 1:1",
		);
	});
});
