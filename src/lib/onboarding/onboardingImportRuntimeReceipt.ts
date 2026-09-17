export interface OnboardingImportDesktopRuntimeReceipt {
	desktopId: string;
	expectedPanelIds: readonly string[];
	livePanelIds: readonly string[];
	attached: boolean;
}

export interface OnboardingImportAgentRuntimeReceipt {
	agentId: string;
	runtime?: string;
	started?: boolean;
	sessionClass: string;
	lifecycle: string;
}

function exactUniqueMembers(
	expected: readonly string[],
	actual: readonly string[],
): boolean {
	return (
		expected.length > 0 &&
		expected.length === actual.length &&
		new Set(expected).size === expected.length &&
		new Set(actual).size === actual.length &&
		expected.every((identity) => actual.includes(identity))
	);
}

/** The real-app import probe is successful only after the planned Dockview
 * identities are live and every exact managed pane has attached. A ready Host
 * without a presentation is not a successful onboarding import. */
export function onboardingImportRuntimeSucceeded(input: {
	expectedDesktopIds: readonly string[];
	expectedAgentIds: readonly string[];
	desktops: readonly OnboardingImportDesktopRuntimeReceipt[];
	agents: readonly OnboardingImportAgentRuntimeReceipt[];
}): boolean {
	return (
		exactUniqueMembers(
		input.expectedDesktopIds,
		input.desktops.map((desktop) => desktop.desktopId),
	) &&
		input.desktops.every(
			(desktop) =>
				desktop.attached &&
				exactUniqueMembers(
					desktop.expectedPanelIds,
					desktop.livePanelIds,
				),
		) &&
		exactUniqueMembers(
			input.expectedAgentIds,
			input.agents.map((agent) => agent.agentId),
		) &&
		input.agents.every(
			(agent) =>
				agent.runtime === "hmux_managed_v1" &&
				agent.started === true &&
				agent.sessionClass === "managed" &&
				agent.lifecycle === "ready",
		)
	);
}
