// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentToolingEnvironmentSnapshot } from "@/lib/agents/agentToolingEnvironment";
import { setLang } from "@/lib/i18n";
import { onOpenSettings } from "@/lib/settings/settingsBus";
import { projectAgentToolingUpdateNotice } from "@/lib/updates/agentToolingUpdateSource";
import {
	dismissUpdateNotice,
	performUpdateNoticeAction,
	resetUpdateNotices,
	updateNoticeSnapshot,
} from "@/lib/updates/updateNotice";

function integrationSnapshot(status: "current" | "outdated") {
	return {
		report: {
			cliState: "ok",
			dependencies: [
				{
					id: "orchestration-integration",
					label: "durable orchestration integration",
					ok: status === "current",
					fixCommand:
						"dure integration install --global --approve-global-config",
					updateCommand:
						"dure integration update --global --approve-global-config",
					uninstallCommand:
						"dure integration uninstall --global --approve-global-config",
					details: [
						{
							provider: "codex" as const,
							status,
							installRoot: "/provider/codex",
							installRootRef: `install-codex-${"a".repeat(32)}`,
							version: "v1",
							digest: "a".repeat(64),
							channel: "test",
							transportRef: "direct-outbound",
							capabilities: ["event_cursor_v1"],
							fixCommand:
								"dure integration install --global --provider codex --approve-global-config",
							updateCommand:
								"dure integration update --global --provider codex --approve-global-config",
							uninstallCommand:
								"dure integration uninstall --global --provider codex --approve-global-config",
							refreshCommand: null,
						},
					],
				},
			],
		},
		cliInstallStatus: {
			state: "current",
			installed: {
				version: "v1",
				digest: "b".repeat(64),
				installRoot: "/cli/v1",
			},
			available: {
				version: "v1",
				digest: "b".repeat(64),
				installRoot: "/cli/v1",
			},
		},
		observed: true,
	} satisfies AgentToolingEnvironmentSnapshot;
}

/** A stale shipped skill, whose guidance action is `target: "skills"`. The
 * three action helpers in agentToolingUpdateSource fall through to
 * `action.dependency`, which that target does not carry, so each needs its own
 * branch. Nothing else in this repository matches over that union, which makes
 * this file the only place the skills branches can be pinned. */
function skillsSnapshot(state: "current" | "missing") {
	return {
		report: {
			cliState: "ok",
			dependencies: [
				{
					id: "dure-skills",
					label: "Dure skills",
					ok: state === "current",
					fixCommand: "dure skills install --global",
					updateCommand: "dure skills update --all --global",
					details: [
						{
							provider: "claude" as const,
							name: "dure-cli",
							state,
							target: "/home/.claude/skills/dure-cli/SKILL.md",
							fixCommand:
								"dure skills install dure-cli --global --provider claude",
							updateCommand:
								"dure skills update dure-cli --global --provider claude",
						},
					],
				},
			],
		},
		cliInstallStatus: {
			state: "current",
			installed: {
				version: "v1",
				digest: "b".repeat(64),
				installRoot: "/cli/v1",
			},
			available: {
				version: "v1",
				digest: "b".repeat(64),
				installRoot: "/cli/v1",
			},
		},
		observed: true,
	} satisfies AgentToolingEnvironmentSnapshot;
}

function cliSnapshot(state: "current" | "outdated") {
	const installedIsCurrent = state === "current";
	return {
		report: {
			cliState: state === "current" ? "ok" : "outdated",
			dependencies: [],
		},
		cliInstallStatus: {
			state,
			installed: {
				version: installedIsCurrent ? "v2" : "v1",
				digest: (installedIsCurrent ? "b" : "a").repeat(64),
				installRoot: installedIsCurrent ? "/cli/v2" : "/cli/v1",
			},
			available: {
				version: "v2",
				digest: "b".repeat(64),
				installRoot: "/cli/v2",
			},
		},
		observed: true,
	} satisfies AgentToolingEnvironmentSnapshot;
}

describe("agent tooling update source", () => {
	afterEach(() => {
		resetUpdateNotices();
		setLang("ko");
	});

	it("routes provider integration updates to the existing approval surface", async () => {
		setLang("en");
		let openedPage: string | undefined;
		const unsubscribe = onOpenSettings((page) => {
			openedPage = page;
		});

		projectAgentToolingUpdateNotice(integrationSnapshot("outdated"));
		expect(updateNoticeSnapshot()).toMatchObject({
			unresolvedCount: 1,
			notices: [
				{
					title: "Agent tooling needs to be updated.",
					details: expect.stringContaining("codex orchestration integration"),
					primaryAction: { label: "Open Settings", completion: "retain" },
				},
			],
		});

		await performUpdateNoticeAction("dure.agent-tooling");

		expect(openedPage).toBe("agentTooling");
		expect(updateNoticeSnapshot().unresolvedCount).toBe(1);
		projectAgentToolingUpdateNotice(integrationSnapshot("current"));
		expect(updateNoticeSnapshot().unresolvedCount).toBe(0);
		unsubscribe();
	});

	it("projects a stale shipped skill through the same approval surface", () => {
		setLang("en");

		projectAgentToolingUpdateNotice(skillsSnapshot("missing"));
		expect(updateNoticeSnapshot()).toMatchObject({
			unresolvedCount: 1,
			notices: [
				{
					// "install", not "update": a missing skill cannot be repaired by
					// `dure skills update --all --global`, which leaves removed skills
					// removed on purpose.
					title: "Agent tooling needs to be installed.",
					details: "Dure skills · dure skills install --global",
					primaryAction: { label: "Open Settings", completion: "retain" },
				},
			],
		});

		projectAgentToolingUpdateNotice(skillsSnapshot("current"));
		expect(updateNoticeSnapshot().unresolvedCount).toBe(0);
	});

	it("automatically refreshes a typed previously approved integration", async () => {
		const outdated = integrationSnapshot("outdated");
		const detail = outdated.report.dependencies[0]?.details?.[0];
		Object.assign(detail ?? {}, {
			refreshCommand:
				"dure integration refresh --global --provider codex",
		});
		const runCommand = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
		const probeEnvironment = vi.fn(async () => integrationSnapshot("current"));
		const dependencies = {
			runCommand,
			probeEnvironment,
		} as Parameters<typeof projectAgentToolingUpdateNotice>[1];

		await projectAgentToolingUpdateNotice(outdated, dependencies);

		expect(runCommand).toHaveBeenCalledWith(
			"dure integration refresh --global --provider codex",
		);
		expect(probeEnvironment).toHaveBeenCalledOnce();
		expect(updateNoticeSnapshot().unresolvedCount).toBe(0);
	});

	it("refreshes through the verified channel CLI when its executable is known", async () => {
		const outdated = integrationSnapshot("outdated");
		Object.assign(outdated.report.dependencies[0]?.details?.[0] ?? {}, {
			refreshCommand:
				"dure integration refresh --global --provider codex",
		});
		Object.assign(outdated.cliInstallStatus.available, {
			executablePath: "/verified channel/bin/dure",
		});
		const runCommand = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
		const probeEnvironment = vi.fn(async () => integrationSnapshot("current"));

		await projectAgentToolingUpdateNotice(outdated, {
			runCommand,
			probeEnvironment,
		} as Parameters<typeof projectAgentToolingUpdateNotice>[1]);

		expect(runCommand).toHaveBeenCalledWith(
			"'/verified channel/bin/dure' integration refresh --global --provider codex",
		);
		expect(updateNoticeSnapshot().unresolvedCount).toBe(0);
	});

	it("refreshes each approved provider once and leaves a non-converging revision manual", async () => {
		const codex = integrationSnapshot("outdated");
		Object.assign(codex.report.dependencies[0]?.details?.[0] ?? {}, {
			refreshCommand:
				"dure integration refresh --global --provider codex",
		});
		const claude = integrationSnapshot("outdated");
		const claudeDetail = claude.report.dependencies[0]?.details?.[0];
		Object.assign(claudeDetail ?? {}, {
			provider: "claude",
			refreshCommand:
				"dure integration refresh --global --provider claude",
		});
		const runCommand = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
		const probeEnvironment = vi
			.fn()
			.mockResolvedValueOnce(claude)
			.mockResolvedValueOnce(claude);
		const dependencies = {
			runCommand,
			probeEnvironment,
		} as Parameters<typeof projectAgentToolingUpdateNotice>[1];

		await projectAgentToolingUpdateNotice(codex, dependencies);

		expect(runCommand.mock.calls).toEqual([
			["dure integration refresh --global --provider codex"],
			["dure integration refresh --global --provider claude"],
		]);
		expect(updateNoticeSnapshot()).toMatchObject({
			unresolvedCount: 1,
			notices: [{ primaryAction: { label: "설정 열기" } }],
		});
	});

	it("invokes the existing CLI installer capability and clears from a fresh probe", async () => {
		setLang("en");
		const installCli = vi.fn(async () => undefined);
		const probeEnvironment = vi.fn(async () => cliSnapshot("current"));

		projectAgentToolingUpdateNotice(cliSnapshot("outdated"), {
			installCli,
			probeEnvironment,
		});
		expect(updateNoticeSnapshot()).toMatchObject({
			unresolvedCount: 1,
			notices: [
				{
					impact:
						"Installs the verified CLI build bundled with the running Dure channel. Running sessions remain active.",
					details: `v1 · ${"a".repeat(64)} · /cli/v1 → v2 · ${"b".repeat(64)} · /cli/v2`,
					primaryAction: { label: "Update", completion: "retain" },
				},
			],
		});

		await performUpdateNoticeAction("dure.agent-tooling");

		expect(installCli).toHaveBeenCalledOnce();
		expect(probeEnvironment).toHaveBeenCalledOnce();
		expect(updateNoticeSnapshot().unresolvedCount).toBe(0);
	});

	it("retains the last projection when no lifecycle authority was observable", () => {
		projectAgentToolingUpdateNotice(cliSnapshot("outdated"));

		projectAgentToolingUpdateNotice({
			report: { cliState: "missing", dependencies: [] },
			cliInstallStatus: null,
			observed: false,
		});

		expect(updateNoticeSnapshot()).toMatchObject({
			unresolvedCount: 1,
			notices: [{ sourceRef: "dure.agent-tooling" }],
		});
	});

	it("treats a changed immutable CLI install root as a replacement revision", () => {
		projectAgentToolingUpdateNotice(cliSnapshot("outdated"));
		const firstRevision = updateNoticeSnapshot().notices[0]?.revision;
		dismissUpdateNotice("dure.agent-tooling");

		const relocated = cliSnapshot("outdated");
		relocated.cliInstallStatus.available.installRoot = "/cli/v2-relocated";
		projectAgentToolingUpdateNotice(relocated);

		expect(updateNoticeSnapshot()).toMatchObject({
			notices: [
				{
					dismissed: false,
					details: expect.stringContaining("/cli/v2-relocated"),
				},
			],
		});
		expect(updateNoticeSnapshot().notices[0]?.revision).not.toBe(firstRevision);
	});
});
