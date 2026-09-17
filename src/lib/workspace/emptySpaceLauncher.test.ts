import { describe, expect, it } from "vitest";
import {
	agentLaunchPlan,
	defaultLaunchDirectory,
	displayLaunchPath,
	providerLaunchRows,
	terminalLaunchPlan,
} from "@/lib/workspace/emptySpaceLauncher";
import type { Project } from "@/types";

const localProject: Project = {
	id: "p1",
	name: "hebbian",
	path: "/Users/dev/hebbian",
	kind: "local",
	isRepo: true,
};
const sshProject: Project = {
	id: "p2",
	name: "remote",
	path: "/srv/remote",
	kind: "ssh",
	sshHostId: "h1",
	isRepo: true,
};

describe("defaultLaunchDirectory", () => {
	it("로컬 포커스 컨텍스트가 등록된 프로젝트보다 우선한다", () => {
		expect(
			defaultLaunchDirectory({
				focusCtx: { cwd: "/repo/x", source: "local", label: "x" },
				projects: [localProject],
			}),
		).toEqual({ path: "/repo/x", source: "focus" });
	});

	it("ssh 포커스 컨텍스트는 건너뛰고 첫 로컬 프로젝트로 간다", () => {
		expect(
			defaultLaunchDirectory({
				focusCtx: { cwd: "/srv/remote", source: "ssh", hostId: "h1", label: "r" },
				projects: [sshProject, localProject],
			}),
		).toEqual({ path: "/Users/dev/hebbian", source: "project" });
	});

	it("아는 디렉토리가 없으면 홈 폴백이다", () => {
		expect(defaultLaunchDirectory({ focusCtx: null, projects: [sshProject] })).toEqual({
			path: null,
			source: "home",
		});
	});

	it("빈 cwd의 포커스 컨텍스트는 무시한다", () => {
		expect(
			defaultLaunchDirectory({
				focusCtx: { cwd: "  ", source: "local", label: "x" },
				projects: [],
			}),
		).toEqual({ path: null, source: "home" });
	});
});

describe("providerLaunchRows", () => {
	it("설치된 provider가 먼저 오고, 각 그룹 안은 카탈로그 순서다", () => {
		const rows = providerLaunchRows({
			available: ["claude", "codex", "kimi"],
			installed: ["kimi"],
			skipPermissions: {},
		});
		expect(rows.map((row) => row.provider)).toEqual(["kimi", "claude", "codex"]);
		expect(rows[0].installed).toBe(true);
		expect(rows[1].installed).toBe(false);
	});

	it("권한 우회가 켜진 provider는 커맨드 미리보기에 플래그가 붙는다", () => {
		const rows = providerLaunchRows({
			available: ["claude", "codex"],
			installed: ["claude", "codex"],
			skipPermissions: { codex: true },
		});
		const byProvider = new Map(rows.map((row) => [row.provider, row.command]));
		expect(byProvider.get("codex")).toBe(
			"codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false",
		);
		expect(byProvider.get("claude")).toBe("claude");
	});
});

describe("launch plans", () => {
	it("터미널은 선택된 디렉토리에서 열리고, 홈 폴백이면 cwd를 지정하지 않는다", () => {
		expect(terminalLaunchPlan({ path: "/repo/x", source: "focus" })).toEqual({
			kind: "terminal",
			cwd: "/repo/x",
		});
		expect(terminalLaunchPlan({ path: null, source: "home" })).toEqual({
			kind: "terminal",
		});
	});

	it("에이전트는 구체적 디렉토리면 즉시 실행, 홈 폴백이면 다이얼로그로 간다", () => {
		expect(
			agentLaunchPlan("claude", { path: "/repo/x", source: "focus" }, "/Users/dev"),
		).toEqual({
			kind: "agent-quick",
			provider: "claude",
			path: "/repo/x",
		});
		expect(agentLaunchPlan("claude", { path: null, source: "home" }, null)).toEqual({
			kind: "agent-dialog",
			provider: "claude",
		});
	});

	// 포커스가 홈에 앉아 있던 터미널에서 왔어도 홈은 홈이다 — quick launch가
	// $HOME을 프로젝트로 등록해 버리는 우회로를 막는다.
	it("경로가 홈 디렉토리면 출처가 무엇이든 에이전트는 다이얼로그로 간다", () => {
		expect(
			agentLaunchPlan(
				"claude",
				{ path: "/Users/dev", source: "focus" },
				"/Users/dev",
			),
		).toEqual({ kind: "agent-dialog", provider: "claude" });
		expect(
			agentLaunchPlan(
				"claude",
				{ path: "/Users/dev", source: "chosen" },
				"/Users/dev",
			),
		).toEqual({ kind: "agent-dialog", provider: "claude" });
	});
});

describe("displayLaunchPath", () => {
	it("홈 아래 경로는 ~로 줄인다", () => {
		expect(displayLaunchPath("/Users/dev/repo", "/Users/dev")).toBe("~/repo");
		expect(displayLaunchPath("/Users/dev", "/Users/dev")).toBe("~");
	});

	it("홈을 모르거나 경계가 어긋나면 원본 그대로다", () => {
		expect(displayLaunchPath("/Users/dev/repo", null)).toBe("/Users/dev/repo");
		expect(displayLaunchPath("/Users/devx/repo", "/Users/dev")).toBe(
			"/Users/devx/repo",
		);
	});
});
