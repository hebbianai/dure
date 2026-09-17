// @vitest-environment jsdom

import {
	message as messageDialog,
	open as openDialog,
} from "@tauri-apps/plugin-dialog";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingPanel } from "@/components/panels/OnboardingPanel";
import { detectInstalledProviders } from "@/lib/agents/agentInstalls";
import { t } from "@/lib/i18n";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import { openCommandTerminalOn } from "@/lib/workspace/dock/openCommandTerminal";
import { useStore } from "@/store";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
	message: vi.fn(),
}));
vi.mock("@/lib/agents/agentInstalls", async (original) => ({
	...(await original<typeof import("@/lib/agents/agentInstalls")>()),
	detectInstalledProviders: vi.fn(async () => []),
	useAvailableProviders: () => [],
}));
vi.mock("@/components/onboarding/OnboardingImportPreview", () => ({
	OnboardingImportPreview: ({
		onStartWithoutSessions,
	}: {
		onStartWithoutSessions: () => void;
	}) => (
		<button type="button" onClick={onStartWithoutSessions}>
			Start from a folder
		</button>
	),
}));
vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	listProviderConversations: vi.fn(async () => []),
}));
vi.mock("@/lib/platform/externalOpen", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/lib/workspace/dock/openCommandTerminal", () => ({
	openCommandTerminalOn: vi.fn(),
}));

const props = {
	api: { id: "onboarding", close: vi.fn() },
	containerApi: {
		panels: [{ id: "onboarding" }],
		onDidAddPanel: () => ({ dispose: vi.fn() }),
		onDidRemovePanel: () => ({ dispose: vi.fn() }),
	},
} as unknown as IDockviewPanelProps;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(invoke).mockImplementation(async (command, args) => {
		if (command === "inspect_local_directory")
			return (args as { path: string }).path;
		if (command === "git_status") return { isRepo: false };
		return undefined;
	});
	useStore.setState({
		uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "pro" },
		projects: [],
		accounts: [],
		activeAccounts: {},
		installedAgents: [],
	});
});
afterEach(cleanup);

it("runs the native Claude installer without npm setup when the npm-based providers are already installed", async () => {
	const platform = vi
		.spyOn(navigator, "platform", "get")
		.mockReturnValue("MacIntel");
	vi.mocked(detectInstalledProviders).mockResolvedValueOnce([
		"gemini", "pi", "qwen-code",
	]);
	try {
		render(<OnboardingPanel {...props} />);
		fireEvent.click(screen.getByRole("button", { name: "Start from a folder" }));
		await waitFor(() =>
			expect(useStore.getState().installedAgents).toEqual([
				"gemini", "pi", "qwen-code",
			]),
		);
		expect(
			screen.queryByRole("button", { name: t("onboarding.install.nodeSetup") }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: `Claude Code ${t("common.install")}` }),
		);
		expect(openCommandTerminalOn).toHaveBeenCalledWith(props.containerApi, {
			title: `Claude Code ${t("common.install")}`,
			command: expect.stringContaining("https://claude.ai/install.sh"),
			closeOnSuccess: true,
		});
		expect(openCommandTerminalOn).toHaveBeenCalledOnce();
	} finally {
		platform.mockRestore();
	}
});

it("opens Node.js guidance independently and keeps the npm installer action available", async () => {
	render(<OnboardingPanel {...props} />);
	fireEvent.click(screen.getByRole("button", { name: "Start from a folder" }));
	fireEvent.click(
		screen.getByRole("button", { name: t("onboarding.install.nodeSetup") }),
	);
	expect(openExternalUrl).toHaveBeenCalledWith(
		"https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/",
	);
	expect(openCommandTerminalOn).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: `Pi ${t("common.install")}` }));
	expect(openCommandTerminalOn).toHaveBeenCalledOnce();
	expect(openCommandTerminalOn).toHaveBeenCalledWith(props.containerApi, {
		title: `Pi ${t("common.install")}`,
		command: expect.stringContaining(
			"npm install -g @earendil-works/pi-coding-agent",
		),
		closeOnSuccess: true,
	});
	expect(props.api.close).not.toHaveBeenCalled();
	await waitFor(() => expect(invoke).toHaveBeenCalled());
});

describe("OnboardingPanel folder actions", () => {
	it("recognizes an already opened folder as a repository after Git installation without duplicating it", async () => {
		let installed = false;
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "inspect_local_directory") return (args as { path: string }).path;
			if (command === "git_availability") return { status: installed ? "available" : "missing" };
			if (command === "git_status") return { isRepo: installed };
			if (command === "git_exec") return { code: 1, stdout: "", stderr: "" };
			return undefined;
		});
		vi.mocked(openDialog).mockResolvedValue("/work/repo");
		render(<OnboardingPanel {...props} />);
		fireEvent.click(screen.getByRole("button", { name: "Start from a folder" }));
		await screen.findByText(t("panels.git.availability.missing"));
		fireEvent.click(screen.getByRole("button", { name: t("onboarding.checklist.openFolder") }));
		await waitFor(() => expect(useStore.getState().projects).toHaveLength(1));
		const before = useStore.getState().projects[0];
		expect(before.isRepo).toBe(false);
		installed = true;
		fireEvent.click(screen.getByRole("button", { name: t("panels.git.availability.recheck") }));
		await waitFor(() => expect(screen.queryByText(t("panels.git.availability.missing"))).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: t("onboarding.checklist.openFolder") }));
		await waitFor(() => expect(useStore.getState().projects).toEqual([{ ...before, isRepo: true }]));
	});

	it("offers Git installation while still opening an ordinary folder without Git", async () => {
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "inspect_local_directory") return (args as { path: string }).path;
			if (command === "git_availability") return { status: "missing" };
			if (command === "git_status") return { isRepo: false };
			if (command === "git_exec") return { code: -1, stdout: "", stderr: "git: not found" };
			return undefined;
		});
		vi.mocked(openDialog).mockResolvedValueOnce("/work/plain-folder");
		render(<OnboardingPanel {...props} />);
		fireEvent.click(screen.getByRole("button", { name: "Start from a folder" }));
		await screen.findByText(t("panels.git.availability.missing"));
		fireEvent.click(screen.getByRole("button", { name: t("onboarding.start.openFolderAndStart") }));
		await waitFor(() => expect(props.api.close).toHaveBeenCalledOnce());
		expect(useStore.getState().projects).toEqual([
			expect.objectContaining({ path: "/work/plain-folder", isRepo: false }),
		]);
	});

	it.each(["sessions", "folder"])(
		"can close the optional guide from its %s view without starting anything",
		async (view) => {
			const before = useStore.getState();
			render(<OnboardingPanel {...props} />);
			if (view === "folder") {
				fireEvent.click(
					screen.getByRole("button", { name: "Start from a folder" }),
				);
			}
			fireEvent.click(screen.getByRole("button", { name: t("common.close") }));
			expect(props.api.close).toHaveBeenCalledOnce();
			expect(openDialog).not.toHaveBeenCalled();
			expect(useStore.getState().projects).toBe(before.projects);
			expect(useStore.getState().agents).toBe(before.agents);
		},
	);

	it.each([
		"onboarding.checklist.openFolder",
		"onboarding.start.openFolderAndStart",
	] as const)(
		"opens the native folder picker directly from %s and leaves onboarding intact on cancel",
		async (label) => {
			vi.mocked(openDialog).mockResolvedValueOnce(null);
			render(<OnboardingPanel {...props} />);
			fireEvent.click(
				screen.getByRole("button", { name: "Start from a folder" }),
			);
			fireEvent.click(screen.getByRole("button", { name: t(label) }));

			await waitFor(() =>
				expect(openDialog).toHaveBeenCalledWith({
					directory: true,
					multiple: false,
					title: t("common.chooseWorkingFolder"),
				}),
			);
			expect(screen.queryByRole("dialog")).toBeNull();
			expect(useStore.getState().projects).toEqual([]);
			expect(screen.getByRole("button", { name: t(label) })).toBeTruthy();
			expect(props.api.close).not.toHaveBeenCalled();
		},
	);
	it.each([false, true])(
		"closes after starting with a %s previously registered folder",
		async (alreadyRegistered) => {
			if (alreadyRegistered)
				await useStore.getState().addLocalProject("/work/first-folder");
			vi.mocked(openDialog).mockResolvedValueOnce("/work/first-folder");
			render(<OnboardingPanel {...props} />);
			const chooseFolderView = screen.queryByRole("button", {
				name: "Start from a folder",
			});
			if (chooseFolderView) fireEvent.click(chooseFolderView);
			fireEvent.click(
				screen.getByRole("button", {
					name: t("onboarding.start.openFolderAndStart"),
				}),
			);
			await waitFor(() => expect(props.api.close).toHaveBeenCalledOnce());
			expect(useStore.getState().projects).toHaveLength(1);
			expect(useStore.getState().projects[0].path).toBe("/work/first-folder");
		},
	);

	it("updates the checklist from the registered folder and does not duplicate it when selected again", async () => {
		vi.mocked(openDialog).mockResolvedValue("/work/first-folder");
		render(<OnboardingPanel {...props} />);
		fireEvent.click(
			screen.getByRole("button", { name: "Start from a folder" }),
		);
		const chooseFolder = screen.getByRole("button", {
			name: t("onboarding.checklist.openFolder"),
		});
		fireEvent.click(chooseFolder);
		await screen.findByText(
			t("onboarding.checklist.foldersRegistered", { count: "1" }),
		);
		expect(useStore.getState().projects).toEqual([
			expect.objectContaining({ path: "/work/first-folder", kind: "local" }),
		]);
		await act(async () => fireEvent.click(chooseFolder));
		expect(openDialog).toHaveBeenCalledTimes(2);
		expect(useStore.getState().projects).toHaveLength(1);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(props.api.close).not.toHaveBeenCalled();
	});

	it.each([
		"onboarding.checklist.openFolder",
		"onboarding.start.openFolderAndStart",
	] as const)(
		"reports a picker failure from %s without registering or closing anything",
		async (label) => {
			vi.mocked(openDialog).mockRejectedValueOnce(
				new Error("picker unavailable"),
			);
			render(<OnboardingPanel {...props} />);
			fireEvent.click(
				screen.getByRole("button", { name: "Start from a folder" }),
			);
			fireEvent.click(
				screen.getByRole("button", {
					name: t(label),
				}),
			);
			await waitFor(() =>
				expect(messageDialog).toHaveBeenCalledWith(
					t("common.folderOpenFailed", { e: "Error: picker unavailable" }),
					{ kind: "error" },
				),
			);
			expect(useStore.getState().projects).toEqual([]);
			expect(screen.queryByRole("dialog")).toBeNull();
			expect(props.api.close).not.toHaveBeenCalled();
		},
	);
});

it("keeps Pro providers out of Basic install offers and detected badges without discarding discovery", async () => {
	useStore.setState({
		uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "basic" },
	});
	vi.mocked(detectInstalledProviders).mockResolvedValueOnce(["gemini"]);
	render(<OnboardingPanel {...props} />);
	fireEvent.click(screen.getByRole("button", { name: "Start from a folder" }));
	await waitFor(() =>
		expect(useStore.getState().installedAgents).toEqual(["gemini"]),
	);
	expect(screen.queryByText("Gemini CLI")).toBeNull();
	expect(
		screen.queryByRole("button", { name: `Pi ${t("common.install")}` }),
	).toBeNull();
	expect(
		screen.getByRole("button", { name: `Claude Code ${t("common.install")}` }),
	).toBeTruthy();
});
