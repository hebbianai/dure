import type { HmuxSessionSummary } from "@/lib/ipc";
import type { UiPrefs } from "@/lib/settings/uiPrefs";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import type { Provider, Space } from "@/types";
import {
	type WorkspacePerformanceProvider,
	workspacePerformanceProviderDescriptor,
} from "./providers";
import type { WorkspacePerformanceScenario } from "./scenario";

const FIXTURE_LAYOUT_WIDTH = 1200;
const FIXTURE_LAYOUT_HEIGHT = 800;

export interface WorkspacePerformanceFixtureSession {
	provider: WorkspacePerformanceProvider;
	desktop: number;
	pane: number;
	cwd: string;
	session: HmuxSessionSummary;
}

export interface WorkspacePerformanceFixture {
	scenario: WorkspacePerformanceScenario;
	spaces: Space[];
	activeSpaceId: string;
	layouts: Record<string, unknown>;
	sessionAgent: Record<string, Provider>;
	panelIdsByDesktop: Record<string, string[]>;
}

export function workspacePerformanceFixtureState(
	fixture: WorkspacePerformanceFixture,
	uiPrefs: UiPrefs,
) {
	return {
		spaces: fixture.spaces,
		activeSpaceId: fixture.activeSpaceId,
		spaceVisits: {},
		projects: [],
		agents: [],
		layouts: fixture.layouts,
		sessionAgent: fixture.sessionAgent,
		sessionTitle: Object.fromEntries(
			Object.entries(fixture.sessionAgent).map(([sessionId, provider]) => [
				sessionId,
				workspacePerformanceProviderDescriptor(provider)?.title ?? provider,
			]),
		),
		// The benchmark measures terminal workspaces, not first-run onboarding.
		// Make that fixture precondition explicit so product onboarding cannot
		// become the active Dockview panel and silently invalidate input samples.
		uiPrefs: {
			...uiPrefs,
			tabOrder: "manual" as const,
			onboardingDismissed: true,
		},
	};
}

export function buildWorkspacePerformanceFixture(
	sessions: readonly WorkspacePerformanceFixtureSession[],
	scenario: WorkspacePerformanceScenario,
): WorkspacePerformanceFixture {
	if (sessions.length !== scenario.terminalCount) {
		throw new Error(
			`workspace performance fixture requires ${scenario.terminalCount} sessions, found ${sessions.length}`,
		);
	}
	const cells = new Set<string>();
	const sessionIds = new Set<string>();
	for (const entry of sessions) {
		const { desktop, pane, provider, session } = entry;
		if (
			!workspacePerformanceProviderDescriptor(provider) ||
			!Number.isInteger(desktop) ||
			desktop < 1 ||
			desktop > scenario.desktopCount ||
			!Number.isInteger(pane) ||
			pane < 1 ||
			pane > scenario.panesPerDesktop ||
			session.sessionClass !== "managed" ||
			session.lifecycle !== "ready" ||
			!session.stopFence
		) {
			throw new Error(
				`workspace performance session is not ready: ${session.sessionId}`,
			);
		}
		const cell = `${desktop}:${pane}`;
		if (cells.has(cell) || sessionIds.has(session.sessionId)) {
			throw new Error(`workspace performance fixture has a duplicate: ${cell}`);
		}
		cells.add(cell);
		sessionIds.add(session.sessionId);
	}

	const spaces = Array.from(
		{ length: scenario.desktopCount },
		(_, index) => ({
			id: `qa-performance-${index + 1}`,
			name: `QA ${index + 1}`,
		}),
	);
	const layouts: Record<string, unknown> = {};
	const sessionAgent: Record<string, Provider> = {};
	const panelIdsByDesktop: Record<string, string[]> = {};
	for (const [desktopIndex, desktop] of spaces.entries()) {
		const desktopNumber = desktopIndex + 1;
		const assigned = sessions
			.filter((entry) => entry.desktop === desktopNumber)
			.sort((left, right) => left.pane - right.pane);
		layouts[desktop.id] = terminalLayout(assigned);
		panelIdsByDesktop[desktop.id] = assigned.map(
			({ session }) => `term:${session.sessionId}`,
		);
		for (const { provider, session } of assigned) {
			sessionAgent[session.sessionId] = provider;
		}
	}
	return {
		scenario,
		spaces,
		activeSpaceId: spaces[0].id,
		layouts,
		sessionAgent,
		panelIdsByDesktop,
	};
}

function terminalLayout(
	sessions: readonly WorkspacePerformanceFixtureSession[],
) {
	const panelIds = sessions.map(({ session }) => `term:${session.sessionId}`);
	const paneWidth = Math.floor(FIXTURE_LAYOUT_WIDTH / sessions.length);
	return {
		grid: {
			root: {
				type: "branch",
				size: FIXTURE_LAYOUT_HEIGHT,
				data: sessions.map(({ session }) => {
					const panelId = `term:${session.sessionId}`;
					return {
						type: "leaf",
						size: paneWidth,
						data: {
							id: `group:${panelId}`,
							views: [panelId],
							activeView: panelId,
							locked: true,
						},
					};
				}),
			},
			width: FIXTURE_LAYOUT_WIDTH,
			height: FIXTURE_LAYOUT_HEIGHT,
			orientation: "HORIZONTAL",
		},
		panels: Object.fromEntries(
			sessions.map(({ cwd, provider, session }) => {
				const panelId = `term:${session.sessionId}`;
				return [
					panelId,
					{
						id: panelId,
						contentComponent: "terminal",
						title:
							workspacePerformanceProviderDescriptor(provider)?.title ??
							provider,
						params: {
							cwd,
							sessionId: session.sessionId,
							binding: hmuxManagedBinding(
								session.sessionId,
								session.workspaceId,
								undefined,
								undefined,
								session.stopFence,
							),
						},
					},
				];
			}),
		),
		activeGroup: `group:${panelIds[0]}`,
	};
}
