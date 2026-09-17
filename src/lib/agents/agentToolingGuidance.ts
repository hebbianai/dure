import {
	type AgentEnvironmentIntegrationDetail,
	type AgentEnvironmentReport,
	integrationDetailsOf,
	skillDetailsOf,
} from "./agentEnvironment";

type AgentEnvironmentDependency = AgentEnvironmentReport["dependencies"][number];

export type AgentToolingGuidanceAction =
	| {
			target: "cli";
			operation: "install" | "update";
	  }
	| {
			target: "integration";
			operation: "install" | "update";
			detail: AgentEnvironmentIntegrationDetail;
	  }
	| {
			target: "skills";
			operation: "install" | "update";
			command: string;
	  }
	| {
			target: "dependency";
			operation: "install";
			dependency: Pick<
				AgentEnvironmentDependency,
				"id" | "label" | "fixCommand"
			>;
	  };

export interface AgentToolingGuidance {
	state: "missing" | "outdated" | "partial";
	actionCount: number;
	nextAction: AgentToolingGuidanceAction;
	/** Every pending repair in order; `nextAction` is its head. */
	actions: AgentToolingGuidanceAction[];
}

function requiredDependencyActions(
	report: AgentEnvironmentReport,
): AgentToolingGuidanceAction[] {
	const actions: AgentToolingGuidanceAction[] = [];
	for (const dependency of report.dependencies) {
		if (dependency.id === "orchestration-integration") {
			for (const detail of integrationDetailsOf(report)) {
				if (detail.status === "current") continue;
				actions.push({
					target: "integration",
					operation: detail.status === "missing" ? "install" : "update",
					detail,
				});
			}
			continue;
		}
		// Skills would emit up to one action per (skill, provider) pair — up to
		// eight on an ordinary machine. One bulk command repairs the whole set,
		// so one aggregate action represents it instead of one per stale skill.
		if (dependency.id === "dure-skills") {
			const stale = skillDetailsOf(report).filter(
				(detail) => detail.state !== "current",
			);
			// `dure skills update --all --global` deliberately does not resurrect a
			// removed skill, while `dure skills install --global` repairs every
			// non-current state — so "install" is the universal repair whenever
			// anything is missing, and "update" only when nothing needs resurrecting.
			// The `updateCommand` test reads as redundant — `dependencyCommandIsOwned`
			// already refuses any `dure-skills` dependency whose updateCommand is not
			// the exact bulk spelling, so it is always present here. It stays because
			// the field is optional on the type, and this narrowing is what keeps
			// `command` a `string` below. Removing it is a compile error; do not
			// replace it with a non-null assertion.
			if (stale.length > 0 && dependency.updateCommand) {
				const missing = stale.some((detail) => detail.state === "missing");
				actions.push({
					target: "skills",
					operation: missing ? "install" : "update",
					command: missing ? dependency.fixCommand : dependency.updateCommand,
				});
			}
			continue;
		}
		if (!dependency.ok) {
			actions.push({
				target: "dependency",
				operation: "install",
				dependency: {
					id: dependency.id,
					label: dependency.label,
					fixCommand: dependency.fixCommand,
				},
			});
		}
	}
	return actions;
}

/** Derive the single next repair from the canonical doctor/CLI status model. */
export function deriveAgentToolingGuidance(
	report: AgentEnvironmentReport | null,
): AgentToolingGuidance | null {
	if (!report) return null;
	if (report.cliState !== "ok") {
		const actions: AgentToolingGuidanceAction[] = [
			{
				target: "cli",
				operation: report.cliState === "missing" ? "install" : "update",
			},
			...requiredDependencyActions(report),
		];
		return {
			state: report.cliState,
			actionCount: actions.length,
			nextAction: actions[0],
			actions,
		};
	}

	const actions = requiredDependencyActions(report);
	const nextAction = actions[0];
	if (!nextAction) return null;
	return {
		state: "partial",
		actionCount: actions.length,
		nextAction,
		actions,
	};
}
