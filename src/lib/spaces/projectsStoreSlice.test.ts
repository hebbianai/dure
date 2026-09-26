import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SshHostConfig } from "@/types";

const remoteProjectDirectoryMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc/telemetry", () => ({ track: vi.fn() }));
vi.mock("@/lib/ipc", () => ({
	hostToOpts: vi.fn(() => ({ target: "host" })),
	parseWorktreeScan: vi.fn(),
	scanWorktrees: vi.fn(),
	scanWorktreesCommand: vi.fn(),
	sshExecOnce: vi.fn(),
	remoteProjectDirectory: remoteProjectDirectoryMock,
}));

import { track } from "@/lib/ipc/telemetry";
import { applyProjectRepositoryObservation, planProjectRegistration } from "./projectAdd";
import { createProjectsStoreSlice } from "./projectsStoreSlice";

beforeEach(() => {
	vi.clearAllMocks();
});

/** Minimal host harness — applies updater patches the way Zustand's set does. */
function harness() {
	const slice = createProjectsStoreSlice(
		(updater) => {
			const next = updater(host.state);
			if (next === host.state) return;
			host.state = { ...host.state, ...next };
		},
		() => host.state,
		async (candidate) => {
			const registration = planProjectRegistration(
				host.state.projects,
				candidate,
			);
			host.state = { ...host.state, projects: registration.projects };
			return registration.project;
		},
		async (project, isRepo) => {
			host.state.projects = applyProjectRepositoryObservation(host.state.projects, project, isRepo);
		},
	);
	const host = {
		state: {
			...slice,
			sshHosts: [] as SshHostConfig[],
		} as ReturnType<typeof createProjectsStoreSlice> & {
			sshHosts: SshHostConfig[];
		},
	};
	return host;
}

const project = (id: string): Project => ({
	id,
	name: id,
	path: `/repo/${id}`,
	kind: "local",
	isRepo: true,
});

describe("projectsStoreSlice", () => {
	it("names a newly registered SSH repository from its origin", async () => {
		const host = harness();
		host.state.sshHosts = [
			{
				id: "host-one",
				name: "one",
				host: "one.example.com",
				port: 22,
				user: "dev",
				auth: "auto",
			},
		];
		remoteProjectDirectoryMock.mockResolvedValue({
			path: "C:/Users/dev/HebbianIDE",
			isRepo: true,
			origin: "git@github.com:hebbianai/dure-internal.git",
		});

		const project = await host.state.addRemoteProject(
			"host-one",
			"C:\\Users\\dev\\HebbianIDE",
		);

		expect(project.name).toBe("dure-internal");
		expect(project.path).toBe("C:/Users/dev/HebbianIDE");
		expect(project.isRepo).toBe(true);
		expect(host.state.projects).toEqual([project]);
	});

	it("offers project_added once per project the store did not know", async () => {
		const host = harness();
		host.state.sshHosts = [
			{
				id: "host-one",
				name: "one",
				host: "one.example.com",
				port: 22,
				user: "dev",
				auth: "auto",
			},
		];
		remoteProjectDirectoryMock.mockResolvedValue({
			path: "/srv/repo",
			isRepo: true,
			origin: null,
		});
		await host.state.addRemoteProject("host-one", "/srv/repo");
		await host.state.addRemoteProject("host-one", "/srv/repo");
		expect(host.state.projects).toHaveLength(1);
		expect(vi.mocked(track).mock.calls).toEqual([
			["project_added", { kind: "ssh" }],
		]);
	});

	it("toggleProjectPin은 켜고 끄기를 반복한다", () => {
		const host = harness();
		host.state.toggleProjectPin("p1");
		expect(host.state.pinnedProjects).toEqual(["p1"]);
		host.state.toggleProjectPin("p1");
		expect(host.state.pinnedProjects).toEqual([]);
	});

	it("ensureProjectForPath는 같은 경로의 기존 프로젝트를 재사용한다", async () => {
		const host = harness();
		const existing = project("p1");
		host.state.projects = [existing];
		const resolved = await host.state.ensureProjectForPath(existing.path);
		expect(resolved).toBe(existing);
		expect(host.state.projects).toHaveLength(1);
	});

	it("scanProject는 repo가 아니거나 모르는 프로젝트면 detected를 건드리지 않는다", async () => {
		const host = harness();
		host.state.projects = [{ ...project("p1"), isRepo: false }];
		host.state.detected = { p1: [] };
		await host.state.scanProject("p1");
		await host.state.scanProject("ghost");
		expect(host.state.detected).toEqual({ p1: [] });
	});
});

it("reuses the canonical remote folder when Windows input spelling differs", async () => {
	const host = harness();
	host.state.sshHosts = [
		{
			id: "remote",
			name: "remote",
			host: "remote.test",
			user: "dev",
			port: 22,
			auth: "auto",
		},
	];
	const existing: Project = {
		id: "existing",
		name: "work",
		path: "C:/Users/dev/work",
		kind: "ssh",
		sshHostId: "remote",
		isRepo: true,
	};
	host.state.projects = [existing];
	remoteProjectDirectoryMock.mockResolvedValue({
		path: existing.path,
		isRepo: true,
		origin: null,
	});
	expect(
		await host.state.ensureProjectForPath("C:\\Users\\dev\\work", "remote"),
	).toBe(existing);
	expect(host.state.projects).toEqual([existing]);
});

it("does not register a folder when its remote inspection fails", async () => {
	const host = harness();
	host.state.sshHosts = [
		{
			id: "remote",
			name: "remote",
			host: "remote.test",
			user: "dev",
			port: 22,
			auth: "auto",
		},
	];
	remoteProjectDirectoryMock.mockRejectedValue(
		new Error("directory was removed"),
	);
	await expect(
		host.state.addRemoteProject("remote", "C:/gone"),
	).rejects.toThrow("directory was removed");
	expect(host.state.projects).toEqual([]);
});
