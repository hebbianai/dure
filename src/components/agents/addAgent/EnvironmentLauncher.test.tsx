// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceEnvironment } from "@/lib/environments/workspaceEnvironmentContract";
import { t } from "@/lib/i18n";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Project } from "@/types";
import { EnvironmentLauncher } from "./EnvironmentLauncher";

const mocks = vi.hoisted(() => ({
	recipes: vi.fn(),
	create: vi.fn(),
	list: vi.fn(),
	connect: vi.fn(),
}));
vi.mock("@/lib/ipc/dureWorkspaceEnvironment", () => ({
	environmentRecipes: mocks.recipes,
	createEnvironment: mocks.create,
	listEnvironments: mocks.list,
}));
vi.mock("@/lib/environments/connectWorkspaceEnvironment", () => ({
	connectWorkspaceEnvironment: mocks.connect,
}));
const authority = testDureBackendRouteAuthority(
	"backend",
	"generation",
	"local",
);
const project: Project = {
	id: "local",
	name: "Project",
	path: "/repo",
	kind: "local",
	isRepo: true,
};
const remote: Project = {
	id: "remote",
	name: "Project",
	path: "/home/dure/project",
	kind: "ssh",
	sshHostId: "vm-host",
	isRepo: true,
};
const running: WorkspaceEnvironment = {
	id: `env-${"a".repeat(64)}`,
	revision: 2,
	name: "Task",
	projectPath: "/repo",
	recipeId: "vm",
	recipeName: "VM",
	status: "running",
	error: null,
	createdAtMs: 1,
	updatedAtMs: 2,
	canSuspend: true,
	connection: {
		host: "127.0.0.1",
		port: 2222,
		user: "dure",
		keyPath: null,
		projectRoot: remote.path,
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.recipes.mockResolvedValue({
		authority,
		proAvailable: true,
		recipes: [
			{
				id: "vm",
				name: "VM",
				digest: `sha256:${"b".repeat(64)}`,
				canSuspend: true,
			},
		],
	});
	mocks.list.mockResolvedValue({
		authority,
		proAvailable: true,
		environments: [running],
	});
	mocks.create.mockResolvedValue(running);
	mocks.connect.mockResolvedValue(remote);
});
afterEach(cleanup);

it("drops the creation receipt when a complete snapshot no longer contains it", async () => {
	mocks.list.mockResolvedValue({
		authority,
		proAvailable: true,
		environments: [],
	});
	render(<EnvironmentLauncher project={project} onReady={vi.fn()} />);
	await expand();
	fireEvent.click(
		screen.getByRole("button", { name: t("environments.prepare") }),
	);
	await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
	await waitFor(() =>
		expect(
			screen.queryByRole("button", { name: t("environments.continue") }),
		).toBeNull(),
	);
});

async function expand() {
	fireEvent.click(
		screen.getByRole("button", { name: t("environments.useVm") }),
	);
	await screen.findByRole("button", { name: t("environments.prepare") });
}
it("requires explicit preparation and respects backend Pro admission", async () => {
	mocks.recipes.mockResolvedValue({
		authority,
		proAvailable: false,
		recipes: [
			{
				id: "vm",
				name: "VM",
				digest: `sha256:${"b".repeat(64)}`,
				canSuspend: true,
			},
		],
	});
	render(<EnvironmentLauncher project={project} onReady={vi.fn()} />);
	expect(mocks.list).not.toHaveBeenCalled();
	await expand();
	fireEvent.click(
		screen.getByRole("button", { name: t("environments.prepare") }),
	);
	expect(mocks.create).not.toHaveBeenCalled();
	expect(screen.getByText(t("environments.proRequired"))).toBeTruthy();
});
it("reuses the original creation identity after a lost acknowledgement", async () => {
	mocks.create
		.mockRejectedValueOnce(new Error("lost acknowledgement"))
		.mockResolvedValueOnce(running);
	render(<EnvironmentLauncher project={project} onReady={vi.fn()} />);
	await expand();
	fireEvent.click(
		screen.getByRole("button", { name: t("environments.prepare") }),
	);
	await screen.findByRole("alert");
	fireEvent.click(screen.getByRole("button", { name: t("common.retry") }));
	await screen.findByRole("button", { name: t("environments.continue") });
	expect(mocks.create).toHaveBeenCalledTimes(2);
	expect(mocks.create.mock.calls[0]).toEqual(mocks.create.mock.calls[1]);
	expect(mocks.connect).not.toHaveBeenCalled();
});
it("hands off the inspected SSH project only while this location remains mounted", async () => {
	let finish: (project: Project) => void = () => {};
	mocks.connect.mockImplementation(
		() =>
			new Promise<Project>((resolve) => {
				finish = resolve;
			}),
	);
	const ready = vi.fn();
	const view = render(
		<EnvironmentLauncher project={project} onReady={ready} />,
	);
	await expand();
	fireEvent.click(
		screen.getByRole("button", { name: t("environments.prepare") }),
	);
	fireEvent.click(
		await screen.findByRole("button", { name: t("environments.continue") }),
	);
	await waitFor(() => expect(mocks.connect).toHaveBeenCalledWith(running));
	view.unmount();
	await act(async () => {
		finish(remote);
	});
	expect(ready).not.toHaveBeenCalled();
});
it("uses the remote project after explicit connection", async () => {
	const ready = vi.fn();
	render(<EnvironmentLauncher project={project} onReady={ready} />);
	await expand();
	fireEvent.click(
		screen.getByRole("button", { name: t("environments.prepare") }),
	);
	fireEvent.click(
		await screen.findByRole("button", { name: t("environments.continue") }),
	);
	await waitFor(() => expect(ready).toHaveBeenCalledExactlyOnceWith(remote));
});
