// @vitest-environment jsdom
//
// The header add menu registers a recent folder in one click, hands the
// native picker the same registration, and omits the recents block when
// nothing is worth suggesting.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/types";

const mocks = vi.hoisted(() => ({
	listProviderConversations: vi.fn(),
	openDialog: vi.fn(),
	messageDialog: vi.fn(),
	addLocalProject: vi.fn(
		async (path: string): Promise<Project> => ({
			id: `proj-${path}`,
			name: path,
			path,
			kind: "local",
			isRepo: true,
		}),
	),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: mocks.openDialog,
	message: mocks.messageDialog,
}));
vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	listProviderConversations: mocks.listProviderConversations,
}));

import { SpacesAddLocationMenu } from "@/components/spaces/SpacesAddLocationMenu";
import { t } from "@/lib/i18n";
import { resetRecentSessionHistoryForTests } from "@/lib/sessions/recentSessionHistoryResource";
import { useStore } from "@/store";

const REGISTERED: Project[] = [
	{ id: "p1", name: "already", path: "/work/already", kind: "local", isRepo: true },
];

function record(cwd: string, mtime: number) {
	return {
		executionLocation: "local",
		cwd,
		repositoryRoot: cwd,
		mtime,
	};
}

function openMenu() {
	fireEvent.pointerDown(
		screen.getByRole("button", { name: t("spaces.locations.add") }),
		{ button: 0, ctrlKey: false },
	);
}

afterEach(() => {
	cleanup();
	resetRecentSessionHistoryForTests();
	useStore.setState({ projects: [], sshHosts: [] });
	vi.clearAllMocks();
});

function closeMenu() {
	fireEvent.keyDown(document, { key: "Escape" });
}

describe("SpacesAddLocationMenu", () => {
	it("lists the folders this machine worked in and registers one on select", async () => {
		mocks.listProviderConversations.mockResolvedValue([
			record("/work/already", 30),
			record("/work/fresh", 20),
			record("/work/older", 10),
		]);
		useStore.setState({
			projects: REGISTERED,
			addLocalProject: mocks.addLocalProject,
		});
		render(<SpacesAddLocationMenu onManageLocations={vi.fn()} />);

		openMenu();
		const fresh = await screen.findByRole("menuitem", { name: /fresh/ });
		// Already-registered folders are not suggested again; recency leads.
		expect(screen.queryByRole("menuitem", { name: /already/ })).toBeNull();
		const names = screen
			.getAllByRole("menuitem")
			.map((item) => item.textContent ?? "");
		expect(names.findIndex((name) => name.includes("fresh"))).toBeLessThan(
			names.findIndex((name) => name.includes("older")),
		);

		fireEvent.click(fresh);

		expect(mocks.addLocalProject).toHaveBeenCalledWith("/work/fresh");
	});

	it("omits the recents block when nothing is worth suggesting", async () => {
		mocks.listProviderConversations.mockResolvedValue([]);
		render(<SpacesAddLocationMenu onManageLocations={vi.fn()} />);

		openMenu();
		await screen.findByRole("menuitem", {
			name: t("spaces.locations.openLocalFolder"),
		});

		expect(screen.queryByText(t("spaces.locations.recentProjects"))).toBeNull();
		expect(
			screen.queryByText(t("spaces.locations.recentProjectsLoading")),
		).toBeNull();
	});

	it("keeps a scan that finishes after the menu closed", async () => {
		let finishScan!: (records: ReturnType<typeof record>[]) => void;
		mocks.listProviderConversations.mockReturnValue(
			new Promise((resolve) => {
				finishScan = resolve;
			}),
		);
		render(<SpacesAddLocationMenu onManageLocations={vi.fn()} />);

		openMenu();
		closeMenu();
		await act(async () => {
			finishScan([record("/work/fresh", 20)]);
		});
		openMenu();

		expect(await screen.findByRole("menuitem", { name: /fresh/ })).toBeTruthy();
		// Closing early must not throw the finished scan away.
		expect(mocks.listProviderConversations).toHaveBeenCalledOnce();
	});

	it("retries a failed scan once the freshness window has passed", async () => {
		let clock = 1_000_000;
		resetRecentSessionHistoryForTests({ now: () => clock });
		mocks.listProviderConversations.mockRejectedValueOnce(new Error("boom"));
		render(<SpacesAddLocationMenu onManageLocations={vi.fn()} />);

		openMenu();
		await screen.findByRole("menuitem", {
			name: t("spaces.locations.openLocalFolder"),
		});
		expect(screen.queryByText(t("spaces.locations.recentProjects"))).toBeNull();
		closeMenu();

		clock += 31_000;
		mocks.listProviderConversations.mockResolvedValueOnce([
			record("/work/fresh", 20),
		]);
		openMenu();

		expect(await screen.findByRole("menuitem", { name: /fresh/ })).toBeTruthy();
	});

	it("hands the native picker's folder to the same registration", async () => {
		mocks.listProviderConversations.mockResolvedValue([]);
		mocks.openDialog.mockResolvedValue("/picked/folder");
		useStore.setState({ addLocalProject: mocks.addLocalProject });
		render(<SpacesAddLocationMenu onManageLocations={vi.fn()} />);

		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: t("spaces.locations.openLocalFolder"),
			}),
		);

		await vi.waitFor(() =>
			expect(mocks.addLocalProject).toHaveBeenCalledWith("/picked/folder"),
		);
	});

	it("offers each SSH host and the location manager", async () => {
		mocks.listProviderConversations.mockResolvedValue([]);
		useStore.setState({
			sshHosts: [
				{
					id: "h1",
					name: "gate1",
					host: "gate1.example",
					port: 22,
					user: "dev",
					auth: "auto",
				},
			],
		});
		const onManageLocations = vi.fn();
		render(<SpacesAddLocationMenu onManageLocations={onManageLocations} />);

		openMenu();
		expect(
			await screen.findByRole("menuitem", {
				name: t("spaces.locations.openFromHost", { name: "gate1" }),
			}),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("menuitem", { name: t("spaces.locations.manage") }),
		);

		expect(onManageLocations).toHaveBeenCalledOnce();
	});
});
