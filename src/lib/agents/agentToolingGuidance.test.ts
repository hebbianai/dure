import { describe, expect, it } from "vitest";
import type { AgentEnvironmentReport } from "./agentEnvironment";
import { deriveAgentToolingGuidance } from "./agentToolingGuidance";

const SKILLS_FIX_COMMAND = "dure skills install --global";
const SKILLS_UPDATE_COMMAND = "dure skills update --all --global";

function skillDetail(
	provider: "claude" | "codex",
	name: string,
	state: "current" | "outdated" | "modified" | "unmanaged" | "missing" = "current",
) {
	return {
		provider,
		name,
		state,
		target: `/${provider}/skills/${name}/SKILL.md`,
		fixCommand: `dure skills install ${name} --global --provider ${provider}`,
		updateCommand: `dure skills update ${name} --global --provider ${provider}`,
	};
}

function skillsDependency(details: ReturnType<typeof skillDetail>[]) {
	return {
		id: "dure-skills",
		label: "Dure skills",
		ok: details.every((detail) => detail.state === "current"),
		fixCommand: SKILLS_FIX_COMMAND,
		updateCommand: SKILLS_UPDATE_COMMAND,
		details,
	};
}

/** A fully current report with both the orchestration integration and every
 * shipped skill reporting `current`, so each test mutates only what it needs. */
function fullyCurrentReport(): AgentEnvironmentReport {
	return {
		cliState: "ok",
		dependencies: [
			{
				id: "orchestration-integration",
				label: "durable orchestration integration",
				ok: true,
				fixCommand: "dure integration install --global --approve-global-config",
				updateCommand: "dure integration update --global --approve-global-config",
				uninstallCommand:
					"dure integration uninstall --global --approve-global-config",
				details: [
					integrationDetail("claude", "current"),
					integrationDetail("codex", "current"),
				],
			},
			skillsDependency([
				skillDetail("claude", "dure-cli"),
				skillDetail("codex", "dure-cli"),
			]),
		],
	};
}

function integrationDetail(
	provider: "claude" | "codex",
	status: "current" | "outdated" | "missing" | "invalid",
) {
	return {
		provider,
		status,
		installRoot: `/integration/${provider}`,
		installRootRef: `install-${provider}-${"a".repeat(32)}`,
		version: "v1",
		digest: "a".repeat(64),
		channel: "stable",
		transportRef: "direct-outbound",
		capabilities: ["event_cursor_v1"],
		fixCommand: `dure integration install --global --provider ${provider} --approve-global-config`,
		updateCommand: `dure integration update --global --provider ${provider} --approve-global-config`,
		uninstallCommand: `dure integration uninstall --global --provider ${provider} --approve-global-config`,
		refreshCommand: null,
	};
}

function report(
	claudeStatus: "current" | "outdated" | "missing" | "invalid",
	codexStatus: "current" | "outdated" | "missing" | "invalid",
	skillOk: boolean,
): AgentEnvironmentReport {
	return {
		cliState: "ok",
		dependencies: [
			{
				id: "orchestration-integration",
				label: "durable orchestration integration",
				ok: claudeStatus === "current" && codexStatus === "current",
				fixCommand:
					"dure integration install --global --approve-global-config",
				updateCommand:
					"dure integration update --global --approve-global-config",
				uninstallCommand:
					"dure integration uninstall --global --approve-global-config",
				details: [
					integrationDetail("claude", claudeStatus),
					integrationDetail("codex", codexStatus),
				],
			},
			{
				id: "dure-skill",
				label: "dure orchestration skill",
				ok: skillOk,
				fixCommand: "dure skills install dure --global",
			},
		],
	};
}

describe("agent tooling guidance", () => {
	it("makes CLI repair the only action until its exact status is current", () => {
		expect(
			deriveAgentToolingGuidance({ cliState: "missing", dependencies: [] }),
		).toEqual({
			state: "missing",
			actionCount: 1,
			nextAction: { target: "cli", operation: "install" },
			actions: [{ target: "cli", operation: "install" }],
		});
		expect(
			deriveAgentToolingGuidance({ cliState: "outdated", dependencies: [] }),
		).toEqual({
			state: "outdated",
			actionCount: 1,
			nextAction: { target: "cli", operation: "update" },
			actions: [{ target: "cli", operation: "update" }],
		});
	});

	it("reports deferred compatible tooling work while keeping the CLI first", () => {
		const outdated = report("current", "invalid", false);
		outdated.cliState = "outdated";

		expect(deriveAgentToolingGuidance(outdated)).toMatchObject({
			state: "outdated",
			actionCount: 3,
			nextAction: { target: "cli", operation: "update" },
		});
	});

	it("preserves partial state and selects the first doctor-owned action", () => {
		const guidance = deriveAgentToolingGuidance(
			report("current", "invalid", false),
		);

		expect(guidance).toMatchObject({
			state: "partial",
			actionCount: 2,
			nextAction: {
				target: "integration",
				operation: "update",
				detail: { provider: "codex" },
			},
		});
		expect(
			deriveAgentToolingGuidance(report("current", "missing", true)),
		).toMatchObject({
			nextAction: {
				target: "integration",
				operation: "install",
				detail: { provider: "codex" },
			},
		});
	});

	it("uses the doctor-owned provider hook command without reconstructing it", () => {
		const hookReport = report("current", "current", true);
		hookReport.dependencies.splice(1, 0, {
			id: "codex-session-hook",
			label: "Codex SessionStart hook",
			ok: false,
			fixCommand: "dure hooks install --global",
		});

		expect(deriveAgentToolingGuidance(hookReport)).toMatchObject({
			state: "partial",
			actionCount: 1,
			nextAction: {
				target: "dependency",
				operation: "install",
				dependency: {
					id: "codex-session-hook",
					fixCommand: "dure hooks install --global",
				},
			},
		});
	});

	it("stays quiet when every reported tool is current", () => {
		expect(deriveAgentToolingGuidance(report("current", "current", true))).toBeNull();
		expect(deriveAgentToolingGuidance(null)).toBeNull();
	});
});

describe("dure skills guidance", () => {
	it("produces no skills action when every skill detail is current", () => {
		expect(deriveAgentToolingGuidance(fullyCurrentReport())).toBeNull();
	});

	it("produces exactly one update action for a single outdated skill", () => {
		const withSkills = fullyCurrentReport();
		withSkills.dependencies[1] = skillsDependency([
			skillDetail("claude", "dure-cli", "outdated"),
			skillDetail("codex", "dure-cli"),
		]);

		expect(deriveAgentToolingGuidance(withSkills)).toMatchObject({
			actionCount: 1,
			nextAction: {
				target: "skills",
				operation: "update",
				command: SKILLS_UPDATE_COMMAND,
			},
		});
	});

	it("prefers install when any stale skill is missing, even alongside an outdated one", () => {
		const withSkills = fullyCurrentReport();
		withSkills.dependencies[1] = skillsDependency([
			skillDetail("claude", "dure-cli", "missing"),
			skillDetail("codex", "dure-cli", "outdated"),
		]);

		expect(deriveAgentToolingGuidance(withSkills)).toMatchObject({
			actionCount: 1,
			nextAction: {
				target: "skills",
				operation: "install",
				command: SKILLS_FIX_COMMAND,
			},
		});
	});

	it("keeps the action count at one no matter how many skills are stale", () => {
		const withSkills = fullyCurrentReport();
		withSkills.dependencies[1] = skillsDependency([
			skillDetail("claude", "dure-cli", "outdated"),
			skillDetail("codex", "dure-cli", "outdated"),
			skillDetail("claude", "commit-review", "modified"),
			skillDetail("codex", "commit-review", "unmanaged"),
			skillDetail("claude", "issue-triage", "missing"),
			skillDetail("codex", "issue-triage", "missing"),
			skillDetail("claude", "release-notes", "outdated"),
			skillDetail("codex", "release-notes", "current"),
		]);

		const guidance = deriveAgentToolingGuidance(withSkills);
		expect(guidance?.actionCount).toBe(1);
		expect(
			guidance?.actions.filter((action) => action.target === "skills"),
		).toHaveLength(1);
	});

	it("yields only the integration action when skills are current but a provider integration is not", () => {
		const withSkills = fullyCurrentReport();
		const integration = withSkills.dependencies[0];
		integration.ok = false;
		integration.details = [
			integrationDetail("claude", "current"),
			integrationDetail("codex", "outdated"),
		];

		const guidance = deriveAgentToolingGuidance(withSkills);
		expect(guidance).toMatchObject({ actionCount: 1 });
		expect(
			guidance?.actions.every((action) => action.target === "integration"),
		).toBe(true);
	});
});
