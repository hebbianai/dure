// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
	createFolderBrowserFlow,
	type FolderBrowserFlowPorts,
	type FolderBrowserScreen,
	type LaunchScreen,
} from "./folderBrowserFlow";
import type { LaunchOffer } from "./ipc";

function offer(folder: string): LaunchOffer {
	return {
		published: true,
		targets: [
			{
				id: `space ${folder}`,
				space_label: "Main",
				folder_label: folder,
				box_label: "",
				path_hint: `~/${folder}`,
				startable: true,
			},
		],
		kinds: [{ id: "claude", label: "Claude Code", installed: true }],
	};
}

const launch: LaunchScreen = {
	kind: "launch",
	hubId: "h1",
	boxLabel: "mac-mini",
	stage: { kind: "ready", offer: offer("old") },
	form: {
		spaceLabel: "Main",
		targetId: "space old",
		kindId: "claude",
		useWorktree: true,
		branch: "agent/mobile",
	},
	menu: undefined,
};

describe("folder browser flow", () => {
	it("switches paired hubs and replaces the launch offer with that hub's authority", async () => {
		let current: FolderBrowserScreen | undefined;
		const show = vi.fn((screen: LaunchScreen | FolderBrowserScreen) => {
			current = screen.kind === "folder-browser" ? screen : undefined;
		});
		const flow = createFolderBrowserFlow({
			browse: async (hubId) => ({
				ok: true,
				path: `/Users/${hubId}`,
				entries: [],
				detail: null,
				code: null,
			}),
			create: vi.fn(),
			offer: async () => offer("new"),
			show,
			remember: (screen) => {
				current = screen;
			},
			current: () => current,
			describeError: String,
		});
		flow.open(launch, [
			{ id: "h1", label: "mac-mini" },
			{ id: "h2", label: "Dure" },
		]);
		await vi.waitFor(() => expect(current?.stage.kind).toBe("ready"));
		if (!current) throw new Error("folder browser did not open");

		const menu = flow.render({ ...current, hostOpen: true });
		menu
			.querySelectorAll<HTMLButtonElement>(".folder-browser__host-option")[1]
			?.click();

		await vi.waitFor(() => expect(current?.hubId).toBe("h2"));
		await vi.waitFor(() => expect(current?.stage.kind).toBe("ready"));
		expect(current?.boxLabel).toBe("Dure");
		expect(current?.returnTo.hubId).toBe("h2");
		expect(current?.returnTo.form.targetId).toBe("space new");
	});

	it("ignores an older response after the same host is reopened", async () => {
		let current: FolderBrowserScreen | undefined;
		const pending: Array<
			(value: Awaited<ReturnType<FolderBrowserFlowPorts["browse"]>>) => void
		> = [];
		const flow = createFolderBrowserFlow({
			browse: () =>
				new Promise((resolve) => {
					pending.push(resolve);
				}),
			create: vi.fn(),
			offer: vi.fn(),
			show: (screen) => {
				current = screen.kind === "folder-browser" ? screen : undefined;
			},
			remember: (screen) => {
				current = screen;
			},
			current: () => current,
			describeError: String,
		});

		flow.open(launch, [{ id: "h1", label: "mac-mini" }]);
		flow.open(launch, [{ id: "h1", label: "mac-mini" }]);
		pending[1]?.({
			ok: true,
			path: "/Users/new",
			entries: [],
			detail: null,
			code: null,
		});
		await vi.waitFor(() => expect(current?.stage.kind).toBe("ready"));
		pending[0]?.({
			ok: true,
			path: "/Users/old",
			entries: [],
			detail: null,
			code: null,
		});
		await Promise.resolve();

		expect(current?.stage.kind === "ready" ? current.stage.path : undefined).toBe(
			"/Users/new",
		);
	});

	it("preserves an explicitly chosen provider when switching to a hub where it is unavailable", async () => {
		let current: FolderBrowserScreen | undefined;
		const flow = createFolderBrowserFlow({
			browse: async () => ({ ok: true, path: "/Users/new", entries: [], detail: null, code: null }),
			create: vi.fn(),
			offer: async () => ({ ...offer("new"), kinds: [
				{ id: "claude", label: "Claude Code", installed: true },
				{ id: "gemini", label: "Gemini", installed: false },
			] }),
			show: (screen) => { current = screen.kind === "folder-browser" ? screen : undefined; },
			remember: (screen) => { current = screen; },
			current: () => current,
			describeError: String,
		});
		flow.open({ ...launch, form: { ...launch.form, kindId: "gemini" } }, [
			{ id: "h1", label: "mac-mini" },
			{ id: "h2", label: "other-mac" },
		]);
		await vi.waitFor(() => expect(current?.stage.kind).toBe("ready"));
		if (!current) throw new Error("folder browser did not open");
		flow.render({ ...current, hostOpen: true })
			.querySelectorAll<HTMLButtonElement>(".folder-browser__host-option")[1]?.click();
		await vi.waitFor(() => expect(current?.returnTo.hubId).toBe("h2"));
		expect(current?.returnTo.form.kindId).toBe("gemini");
		expect(current?.returnTo.form.useWorktree).toBe(true);
		expect(current?.returnTo.form.branch).toBe("agent/mobile");
	});
});
