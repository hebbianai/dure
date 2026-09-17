import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withoutLocalGitOverrides } from "../../../../scripts/lib/git-environment.mjs";
import type { Project } from "@/types";
import { gitExec, gitInfo } from "./git";

const ipc = vi.hoisted(() => ({ local: vi.fn(), ssh: vi.fn() }));
vi.mock("@/lib/ipc", () => ({
	gitExecLocal: ipc.local,
	sshExecOnce: ipc.ssh,
	hostToOpts: (host: unknown) => host,
}));
vi.mock("@/store", () => ({
	useStore: { getState: () => ({ sshHosts: [{ id: "host-a" }] }) },
}));

const roots: string[] = [];
const environment = { ...withoutLocalGitOverrides(), GIT_OPTIONAL_LOCKS: "1" };
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	vi.clearAllMocks();
});

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "dure-status-read-"));
	roots.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], {
			env: environment,
			stdio: "pipe",
		});
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Status fixture");
	git("config", "user.email", "status@example.invalid");
	git("config", "commit.gpgSign", "false");
	git("config", "core.hooksPath", join(root, "no-hooks"));
	for (const name of ["clean.txt", "dirty.txt", "staged.txt"])
		writeFileSync(join(root, name), "before\n");
	git("add", ".");
	git("commit", "-qm", "fixture");
	writeFileSync(join(root, "dirty.txt"), "after\n");
	writeFileSync(join(root, "staged.txt"), "after\n");
	git("add", "staged.txt");
	writeFileSync(join(root, "new.txt"), "new\n");
	// Content is unchanged but its cached index stat is stale, as after an
	// editor saves identical text. A normal status read writes a new index.
	utimesSync(join(root, "clean.txt"), new Date(60_000), new Date(60_000));
	return root;
}

function result(command: string, args: string[]) {
	const child = spawnSync(command, args, {
		env: environment,
		encoding: "utf8",
	});
	if (child.error) throw child.error;
	return {
		stdout: child.stdout,
		stderr: child.stderr,
		code: child.status ?? -1,
	};
}

it.each(["local", "ssh"] as const)(
	"%s status reports current changes without rewriting the index",
	async (kind) => {
		const root = fixture();
		ipc.local.mockImplementation(async (path: string, args: string[]) =>
			result("git", ["-C", path, ...args]),
		);
		// Execute the exact product-generated remote shell command against the
		// disposable repository; no real SSH host or credential is contacted.
		ipc.ssh.mockImplementation(async (_host: unknown, command: string) =>
			result("sh", ["-c", command]),
		);
		const project = {
			id: "fixture",
			name: "fixture",
			path: root,
			kind,
			sshHostId: "host-a",
		} as Project;
		const index = join(root, ".git", "index");
		const before = readFileSync(index);
		const modified = statSync(index).mtimeMs;
		for (let read = 0; read < 3; read++) {
			const info = await gitInfo(project);
			expect(info.branch).toBe("main");
			expect(info.files).toEqual(
				expect.arrayContaining([
					{ xy: ".M", path: "dirty.txt" },
					{ xy: "M.", path: "staged.txt" },
					{ xy: "??", path: "new.txt" },
				]),
			);
			expect(info.files).toHaveLength(3);
			expect(readFileSync(index)).toEqual(before);
			expect(statSync(index).mtimeMs).toBe(modified);
		}
		// Explicit user writes still go through the normal mutation path.
		expect((await gitExec(project, ["add", "dirty.txt"])).code).toBe(0);
		expect((await gitInfo(project)).files).toContainEqual({
			xy: "M.",
			path: "dirty.txt",
		});
	},
);
