// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { t } from "@/lib/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({
	confirm: vi.fn(),
	message: vi.fn(),
	open: vi.fn(),
	openGitPanel: vi.fn(),
	listProviderConversations: vi.fn(),
	addLocalProject: vi.fn(),
	invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	confirm: mocks.confirm,
	message: mocks.message,
	open: mocks.open,
}));
vi.mock("@/lib/workspace/dock/openScmPanel", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/openScmPanel")
	>()),
	openGitPanel: mocks.openGitPanel,
}));
vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	listProviderConversations: mocks.listProviderConversations,
}));

import { LocationManagerDialog } from "@/components/spaces/LocationManagerDialog";
import { useStore } from "@/store";

const projects: Project[] = [
	{
		id: "project-local",
		name: "Hebbian",
		path: "/work/hebbian",
		kind: "local",
		isRepo: true,
	},
	{
		id: "project-remote",
		name: "runtime",
		path: "/srv/runtime",
		kind: "ssh",
		sshHostId: "host-pixel",
		isRepo: false,
	},
];

const hosts: SshHostConfig[] = [
	{
		id: "host-pixel",
		name: "pixel",
		host: "pixel.example.com",
		port: 22,
		user: "dev",
		auth: "auto",
	},
];

describe("LocationManagerDialog", () => {
	it("searches this computer beyond session history and registers a result", async () => {
		mocks.listProviderConversations.mockResolvedValue([]);
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === "search_local_directories") return ["/work/unseen"];
			if (command === "locate_git_checkout_paths") return [{ schemaVersion: 1, canonicalPath: "/work/unseen", gitCommonDir: "/work/unseen/.git" }];
			return undefined;
		});
		useStore.setState({ addLocalProject: mocks.addLocalProject } as never);
		render(<LocationManagerDialog open onOpenChange={vi.fn()} />);
		fireEvent.change(screen.getByPlaceholderText(t("spaces.locations.searchPlaceholder")), { target: { value: "unseen" } });
		const result = await screen.findByText("/work/unseen");
		fireEvent.click(result);
		await waitFor(() => expect(mocks.addLocalProject).toHaveBeenCalledWith("/work/unseen"));
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.invoke.mockReset();
		mocks.confirm.mockResolvedValue(false);
		mocks.listProviderConversations.mockResolvedValue([]);
		useStore.setState({
			projects,
			sshHosts: hosts,
			pinnedProjects: ["project-remote"],
			agents: [],
			activeSpaceId: "desktop-main",
		});
	});

	afterEach(cleanup);

	it("manages registered locations without making Project a top-level tab", async () => {
		render(<LocationManagerDialog open onOpenChange={vi.fn()} />);

		expect(screen.getByRole("heading", { name: t("spaces.locations.manage") })).toBeTruthy();
		expect(screen.getByText("/work/hebbian")).toBeTruthy();
		expect(screen.getByText("/srv/runtime")).toBeTruthy();

		fireEvent.change(
			screen.getByPlaceholderText(t("spaces.locations.searchPlaceholder")),
			{
				target: { value: "pixel" },
			},
		);
		expect(screen.getByText("runtime")).toBeTruthy();
		expect(screen.queryByText("Hebbian")).toBeNull();

		fireEvent.change(
			screen.getByPlaceholderText(t("spaces.locations.searchPlaceholder")),
			{
				target: { value: "" },
			},
		);
		const remoteRow = document.querySelector(
			'[data-location-id="project-remote"]',
		);
		const localRow = document.querySelector(
			'[data-location-id="project-local"]',
		);
		expect(remoteRow).toBeTruthy();
		expect(localRow).toBeTruthy();
		const dataTransfer = { effectAllowed: "none" };
		fireEvent.dragStart(remoteRow as Element, { dataTransfer });
		fireEvent.dragOver(localRow as Element, { dataTransfer });
		fireEvent.drop(localRow as Element, { dataTransfer });
		expect(useStore.getState().projects.map((project) => project.id)).toEqual([
			"project-remote",
			"project-local",
		]);

		fireEvent.click(screen.getByRole("button", { name: "상단 고정" }));
		expect(useStore.getState().pinnedProjects).toContain("project-local");

		fireEvent.click(screen.getByRole("button", { name: "Git (pull·push·commit·PR)" }));
		expect(mocks.openGitPanel).toHaveBeenCalledWith(
			"desktop-main",
			"project-local",
			"Hebbian",
		);

		fireEvent.click(
			screen.getAllByRole("button", { name: t("spaces.locations.remove") })[0],
		);
		// 확인은 그 자리에서(SOUL §6): 팝업 대신 행이 인라인 확인 행으로 바뀐다.
		const confirmRow = await screen.findByRole("alertdialog");
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(confirmRow.getAttribute("aria-label")).toContain("runtime");
		fireEvent.click(
			within(confirmRow).getByRole("button", { name: t("common.cancel") }),
		);
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(useStore.getState().projects).toHaveLength(2);
	});

	it("offers folders the machine already worked in when nothing matches yet", async () => {
		mocks.listProviderConversations.mockResolvedValue([
			// 이미 등록된 위치는 다시 권하지 않는다.
			{ provider: "codex", id: "a", cwd: "/work/hebbian", title: "x", mtime: 90, resumeCapability: "exact", executionLocation: "local" },
			{ provider: "codex", id: "b", cwd: "/work/atlas/sub", repositoryRoot: "/work/atlas", title: "y", mtime: 50, resumeCapability: "exact", executionLocation: "local" },
			{ provider: "claude", id: "c", cwd: "/work/atlas", title: "z", mtime: 70, resumeCapability: "exact", executionLocation: "local" },
		]);
		useStore.setState({ addLocalProject: mocks.addLocalProject } as never);
		render(<LocationManagerDialog open onOpenChange={vi.fn()} />);

		await screen.findByText("/work/atlas");
		// 두 대화가 같은 저장소를 가리키므로 한 줄로 합쳐진다.
		expect(screen.getByText("세션 2개")).toBeTruthy();
		expect(document.querySelectorAll("[data-location-suggestion]")).toHaveLength(1);

		// 등록된 위치가 없어도 검색이 이 목록을 좁힌다 — 사용자가 겪은 "검색이
		// 아무 일도 안 한다"가 여기서 끊긴다.
		fireEvent.change(screen.getByPlaceholderText(t("spaces.locations.searchPlaceholder")), {
			target: { value: "없는폴더" },
		});
		expect(document.querySelectorAll("[data-location-suggestion]")).toHaveLength(0);
		fireEvent.change(screen.getByPlaceholderText(t("spaces.locations.searchPlaceholder")), {
			target: { value: "atlas" },
		});
		expect(document.querySelectorAll("[data-location-suggestion]")).toHaveLength(1);

		fireEvent.click(
			document.querySelector('[data-location-suggestion="/work/atlas"]') as Element,
		);
		await waitFor(() =>
			expect(mocks.addLocalProject).toHaveBeenCalledWith("/work/atlas"),
		);
	});
});
