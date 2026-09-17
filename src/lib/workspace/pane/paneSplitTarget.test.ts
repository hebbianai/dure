import { describe, expect, it } from "vitest";
import { resolvePaneSplitTarget } from "@/lib/workspace/pane/paneSplitTarget";
import {
	hmuxManagedBinding,
	remoteHmuxStandaloneBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";

const legacyLocalBinding = (sessionId: string) =>
	({
		schemaVersion: 1,
		runtime: "legacy_session_v1",
		source: "local",
		hostId: "local",
		sessionId,
	}) as unknown as TerminalPaneBindingV1;
const legacySshBinding = (sessionId: string, hostId: string) =>
	({
		schemaVersion: 1,
		runtime: "legacy_ssh_session_v1",
		source: "ssh",
		hostId,
		sessionId,
	}) as unknown as TerminalPaneBindingV1;

describe("resolvePaneSplitTarget", () => {
	it("keeps a local pane local", () => {
		expect(
			resolvePaneSplitTarget({
				binding: legacyLocalBinding("term-1"),
				paneCwd: "/repo",
			}),
		).toEqual({ kind: "local", cwd: "/repo" });
	});

	it("splits an SSH pane onto the same host", () => {
		expect(
			resolvePaneSplitTarget({
				binding: legacySshBinding("ssh-1", "host-a"),
				paneCwd: "/home/me",
			}),
		).toEqual({ kind: "ssh", hostId: "host-a", cwd: "/home/me" });
	});

	it("splits a remote Hmux pane onto its host, not the local machine", () => {
		// 탭 헤더 분할이 binding을 보지 않아 로컬 셸을 열던 회귀.
		expect(
			resolvePaneSplitTarget({
				binding: remoteHmuxStandaloneBinding("s1", "w1", "host-b", "nonce"),
				paneCwd: "/srv/app",
			}),
		).toEqual({ kind: "ssh", hostId: "host-b", cwd: "/srv/app" });
	});

	it("prefers the live cwd over the pane's initial cwd", () => {
		// ssh로 홈에 접속해 `cd folder`를 했으면 folder에서 분할된다.
		expect(
			resolvePaneSplitTarget({
				binding: legacySshBinding("ssh-1", "host-a"),
				liveCwd: "/home/me/folder",
				paneCwd: "/home/me",
			}),
		).toEqual({ kind: "ssh", hostId: "host-a", cwd: "/home/me/folder" });
	});

	it("falls back to the agent worktree when no cwd was observed", () => {
		expect(
			resolvePaneSplitTarget({
				binding: legacyLocalBinding("agent-1"),
				worktreePath: "/repo/.worktrees/a",
			}),
		).toEqual({ kind: "local", cwd: "/repo/.worktrees/a" });
	});

	it("prefers an agent's live cwd over its worktree path", () => {
		expect(
			resolvePaneSplitTarget({
				binding: legacyLocalBinding("agent-1"),
				liveCwd: "/repo/.worktrees/a/src",
				worktreePath: "/repo/.worktrees/a",
			}),
		).toEqual({ kind: "local", cwd: "/repo/.worktrees/a/src" });
	});

	it("ignores blank cwd candidates", () => {
		expect(
			resolvePaneSplitTarget({ liveCwd: "  ", paneCwd: "", worktreePath: "" }),
		).toEqual({ kind: "local" });
	});

	it("uses params.hostId for pre-binding SSH pane layouts", () => {
		expect(resolvePaneSplitTarget({ paneHostId: "host-c" })).toEqual({
			kind: "ssh",
			hostId: "host-c",
		});
	});

	it("uses the project host for a binding-less SSH agent pane", () => {
		expect(
			resolvePaneSplitTarget({
				projectSshHostId: "host-d",
				worktreePath: "/srv/work",
			}),
		).toEqual({ kind: "ssh", hostId: "host-d", cwd: "/srv/work" });
	});

	it("lets a local binding win over a stale hostId param", () => {
		expect(
			resolvePaneSplitTarget({
				binding: hmuxManagedBinding("s2", "w2"),
				paneHostId: "host-a",
				projectSshHostId: "host-b",
			}),
		).toEqual({ kind: "local" });
	});

	it("treats the sentinel local hostId as local", () => {
		expect(resolvePaneSplitTarget({ paneHostId: "local" })).toEqual({
			kind: "local",
		});
	});
});
