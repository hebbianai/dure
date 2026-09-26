import { beforeEach, describe, expect, it, vi } from "vitest";

const gitStatusMock = vi.fn();
const gitExecLocalMock = vi.fn();
const codexTrustMock = vi.fn();
const inspectDirectoryMock = vi.fn();

vi.mock("@/lib/ipc", () => ({
	gitStatus: (path: string) => gitStatusMock(path),
	gitExecLocal: (path: string, args: string[]) => gitExecLocalMock(path, args),
	codexTrustWorkspace: (path: string) => codexTrustMock(path),
	inspectLocalDirectory: (path: string) => inspectDirectoryMock(path),
}));

import {
	createLocalProject,
	inspectLocalProject,
	projectNameForPath,
	applyProjectRepositoryObservation,
} from "@/lib/spaces/projectAdd";
import type { Project } from "@/types";

describe("repository observation", () => {
	const snapshot: Project = { id: "repo", name: "Original", path: "/repo", kind: "local", isRepo: false };
	it("preserves a concurrent rename and only updates the observed repository flag", () => {
		expect(applyProjectRepositoryObservation([{ ...snapshot, name: "Renamed" }], snapshot, true))
			.toEqual([{ ...snapshot, name: "Renamed", isRepo: true }]);
	});
	it("does not resurrect a removed project, redirect a moved one, or replace a newer observation", () => {
		expect(applyProjectRepositoryObservation([], snapshot, true)).toEqual([]);
		const moved = { ...snapshot, path: "/moved" };
		expect(applyProjectRepositoryObservation([moved], snapshot, true)).toEqual([moved]);
		const newer = { ...snapshot, isRepo: true };
		expect(applyProjectRepositoryObservation([newer], snapshot, false)).toEqual([newer]);
	});
});

beforeEach(() => {
	vi.clearAllMocks();
	gitStatusMock.mockResolvedValue({ isRepo: true });
	gitExecLocalMock.mockResolvedValue({
		stdout: "",
		stderr: "",
		code: 1,
	});
	codexTrustMock.mockResolvedValue(true);
	inspectDirectoryMock.mockImplementation(async (path: string) => path);
});

describe("projectNameForPath", () => {
	it("마지막 경로 이름을 쓴다", () => {
		expect(projectNameForPath("/a/b/HebbianIDE")).toBe("HebbianIDE");
	});

	it("후행 슬래시가 있어도 같다", () => {
		expect(projectNameForPath("/a/b/HebbianIDE/")).toBe("HebbianIDE");
	});

	it("이름을 뽑을 수 없으면 경로 그대로", () => {
		expect(projectNameForPath("/")).toBe("/");
	});
});

describe("inspectLocalProject", () => {
	it("does not mistake an absent folder for a valid non-Git location", async () => {
		gitStatusMock.mockResolvedValue({ isRepo: false });
		inspectDirectoryMock.mockRejectedValue(
			new Error("/missing: No such file or directory"),
		);
		await expect(createLocalProject("/missing")).rejects.toThrow(
			"No such file or directory",
		);
		expect(codexTrustMock).not.toHaveBeenCalled();
		expect(gitStatusMock).not.toHaveBeenCalled();
	});
	it("does not trust a folder during inspection", async () => {
		await inspectLocalProject("/Users/jwan");
		expect(codexTrustMock).not.toHaveBeenCalled();
	});
});

describe("createLocalProject", () => {
	it("uses the origin repository name instead of the checkout directory name", async () => {
		gitExecLocalMock.mockImplementation((_path: string, args: string[]) => {
			if (args[0] === "worktree") {
				return Promise.resolve({
					stdout:
						"worktree /a/b/HebbianIDE\0HEAD abc\0branch refs/heads/main\0\0",
					stderr: "",
					code: 0,
				});
			}
			return Promise.resolve({
				stdout: "https://github.com/hebbianai/dure-internal.git\n",
				stderr: "",
				code: 0,
			});
		});

		const project = await createLocalProject("/a/b/HebbianIDE");

		expect(project.name).toBe("dure-internal");
	});

	it("linked worktree를 공통 저장소의 primary Project로 정규화한다", async () => {
		gitExecLocalMock.mockResolvedValue({
			stdout:
				"worktree /a/b/HebbianIDE\0HEAD abc\0branch refs/heads/main\0\0worktree /a/b/HebbianIDE/.worktrees/patric\0HEAD def\0branch refs/heads/patric\0\0",
			stderr: "",
			code: 0,
		});
		const project = await createLocalProject(
			"/a/b/HebbianIDE/.worktrees/patric",
		);

		expect(project).toMatchObject({
			name: "HebbianIDE",
			path: "/a/b/HebbianIDE",
			kind: "local",
			isRepo: true,
		});
		expect(gitExecLocalMock).toHaveBeenCalledWith(
			"/a/b/HebbianIDE/.worktrees/patric",
			["worktree", "list", "--porcelain", "-z"],
		);
		expect(codexTrustMock).toHaveBeenCalledWith("/a/b/HebbianIDE");
	});

	it("추가한 경로만 Codex 신뢰에 넣는다 — 넓히지 않는다", async () => {
		await createLocalProject("/a/b/proj");
		expect(codexTrustMock).toHaveBeenCalledTimes(1);
		expect(codexTrustMock).toHaveBeenCalledWith("/a/b/proj");
	});

	it("git 상태를 프로젝트에 반영한다", async () => {
		gitStatusMock.mockResolvedValue({ isRepo: false });
		const project = await createLocalProject("/a/b/proj");
		expect(project).toMatchObject({
			name: "proj",
			path: "/a/b/proj",
			kind: "local",
			isRepo: false,
		});
		expect(project.id).toMatch(/^proj-/);
	});

	// 신뢰 등록이 실패해도 결과는 "modal이 뜬다"일 뿐이다 — 그것 때문에
	// 프로젝트를 못 여는 게 더 나쁘다.
	it("신뢰 등록이 실패해도 프로젝트 추가를 막지 않는다", async () => {
		codexTrustMock.mockRejectedValue(new Error("no codex home"));
		await expect(createLocalProject("/a/b/proj")).resolves.toMatchObject({
			path: "/a/b/proj",
		});
	});

	it("waits for the canonical trust attempt before returning", async () => {
		let resolveTrust!: (value: boolean) => void;
		let markTrustStarted!: () => void;
		const trustStarted = new Promise<void>((resolve) => {
			markTrustStarted = resolve;
		});
		codexTrustMock.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					resolveTrust = resolve;
					markTrustStarted();
				}),
		);

		let settled = false;
		const creation = createLocalProject("/a/b/proj").finally(() => {
			settled = true;
		});
		await trustStarted;
		await Promise.resolve();
		expect(settled).toBe(false);

		resolveTrust(true);
		await expect(creation).resolves.toMatchObject({ path: "/a/b/proj" });
	});

	it("registers a validated folder when Git information is unavailable", async () => {
		gitExecLocalMock.mockRejectedValue(new Error("Git unavailable"));
		gitStatusMock.mockRejectedValue(new Error("Git metadata is unreadable"));
		await expect(createLocalProject("/a/b/proj")).resolves.toMatchObject({
			name: "proj",
			path: "/a/b/proj",
			kind: "local",
			isRepo: false,
		});
		expect(inspectDirectoryMock).toHaveBeenCalledWith("/a/b/proj");
		expect(codexTrustMock).toHaveBeenCalledWith("/a/b/proj");
	});

	it("uses the inspected canonical folder when Git cannot normalize an alias", async () => {
		inspectDirectoryMock.mockResolvedValue("/private/tmp/workspace");
		gitExecLocalMock.mockRejectedValue(new Error("Git unavailable"));
		gitStatusMock.mockResolvedValue({ isRepo: false });
		await expect(createLocalProject("/tmp/workspace")).resolves.toMatchObject({
			path: "/private/tmp/workspace",
			name: "workspace",
			isRepo: false,
		});
		expect(gitStatusMock).toHaveBeenCalledWith("/private/tmp/workspace");
		expect(codexTrustMock).toHaveBeenCalledWith("/private/tmp/workspace");
	});
});
