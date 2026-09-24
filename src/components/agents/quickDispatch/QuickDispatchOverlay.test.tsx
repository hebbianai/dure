// @vitest-environment jsdom
import { openSelect } from "@/test/select";

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickDispatchIntentV1 } from "@/lib/agents/quickDispatch/quickDispatchIntent";
import { t } from "@/lib/i18n";
import { moveQuickCommand } from "@/lib/workspace/pane/quickCommands";
import type { AccountProfile, Project } from "@/types";

// vi.mock factories are hoisted above the whole file, and QuickDispatchOverlay
// (imported below) statically imports "@/lib/ipc" -> "./ipc/system" -
// evaluated before this file's own top-level statements. A plain `const`
// referenced by a factory would hit the TDZ (see AddAgentBody.test.tsx's own
// `vi.hoisted` mocks for the same reason); `vi.hoisted` builds the fns at
// hoist time instead.
const mocks = vi.hoisted(() => {
	const journal = { intents: [] as unknown[] };
	return {
		journal,
		begin: vi.fn((input: unknown) => ({
			...(input as object),
			schemaVersion: 1,
			intentId: "qd_1",
			createdAtMs: 0,
			state: "pending",
		})),
		complete: vi.fn(),
		newId: vi.fn(() => "qd_1"),
		read: vi.fn(() => journal.intents),
		run: vi.fn().mockResolvedValue(undefined),
		saveRemote: vi.fn().mockResolvedValue(["/tmp/remote/image.png"]),
		saveAttachments: vi.fn().mockResolvedValue([]),
		homeDir: vi.fn(),
		ensureProject: vi.fn(),
		catalog: vi.fn().mockResolvedValue([]),
		paste: vi.fn(),
	};
});
vi.mock("@/lib/files/sessionFileTransfer", () => ({ saveSessionFiles: mocks.saveRemote }));
vi.mock("@/lib/platform/clipboardImagePaste", () => ({ resolvePaste: mocks.paste }));
vi.mock("@/lib/ipc/providerCatalog", () => ({
	readProviderCatalog: mocks.catalog,
}));
vi.mock("@/lib/agents/quickDispatch/quickDispatchIntent", async (orig) => ({
	...(await orig<object>()),
	beginQuickDispatchIntent: (input: never) => mocks.begin(input),
	completeQuickDispatchIntent: (intentId: string) => mocks.complete(intentId),
	newQuickDispatchIntentId: () => mocks.newId(),
	readQuickDispatchIntents: () => mocks.read(),
}));
vi.mock("@/lib/agents/quickDispatch/quickDispatchRun", () => ({
	runQuickDispatch: (intent: never) => mocks.run(intent),
}));
vi.mock("@/lib/ipc/system", async (orig) => ({
	...(await orig<object>()),
	saveQuickDispatchAttachments: mocks.saveAttachments,
}));
vi.mock("@/lib/ipc/git", async (orig) => ({
	...(await orig<object>()),
	homeDir: mocks.homeDir,
}));

import { QuickDispatchOverlay } from "@/components/agents/quickDispatch/QuickDispatchOverlay";
import { useStore } from "@/store";

const repo: Project = {
	id: "project-repo",
	name: "repo",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const homeProject: Project = {
	id: "project-home",
	name: "Home",
	path: "/home/test",
	kind: "local",
	isRepo: false,
};

const claudeWork: AccountProfile = {
	id: "acc-claude-work",
	provider: "claude",
	name: "Claude work",
	dir: "/accounts/claude-work",
};

const codexPersonal: AccountProfile = {
	id: "acc-codex-personal",
	provider: "codex",
	name: "Codex personal",
	dir: "/accounts/codex-personal",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.homeDir.mockReset().mockResolvedValue(homeProject.path);
	mocks.ensureProject.mockReset().mockImplementation(async () => {
		useStore.setState({ projects: [...useStore.getState().projects, homeProject] });
		return homeProject;
	});
	mocks.journal.intents = [];
	useStore.setState({
		uiPrefs: { ...useStore.getState().uiPrefs, quickCommands: [], interfaceMode: "pro" },
		projects: [repo],
		ensureProjectForPath: mocks.ensureProject,
		sshHosts: [],
		agents: [],
		installedAgents: [],
		focusCtx: null,
		activeSpaceId: "desktop-1",
		spaces: [{ id: "desktop-1", name: "Main" }],
		accounts: [],
		activeAccounts: {},
	});
});

afterEach(() => {
	cleanup();
});

function openPermissions() {
	openSelect(screen.getByRole("combobox", { name: t("agents.chat.permissionLabel") }));
}

async function choosePermission(label: string) {
	openPermissions();
	fireEvent.click(await screen.findByRole("option", { name: label }));
}

describe("QuickDispatchOverlay", () => {
	it("clears the project and starts in the home folder without worktree setup", async () => {
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Plan my day" } });
		fireEvent.click(screen.getByRole("switch", { name: t("agents.worktree.isolateDedicated") }));
		openSelect(screen.getByRole("combobox", { name: t("agents.quickDispatch.projectLabel") }));
		fireEvent.click(screen.getByRole("option", { name: t("agents.quickDispatch.noProject") }));
		expect(screen.getByRole<HTMLButtonElement>("switch").disabled).toBe(true);
		expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
		expect(mocks.ensureProject).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: t("agents.quickDispatch.startAgent") }));
		await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
		expect(mocks.ensureProject).toHaveBeenCalledWith(homeProject.path);
		expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({
			projectId: homeProject.id, promptText: "Plan my day", useWorktree: false, runSetup: false,
		}));
		expect(mocks.begin.mock.calls[0][0]).not.toHaveProperty("remoteTarget");
	});

	it("accepts an image-only request before any project has been registered", async () => {
		useStore.setState({ projects: [] });
		mocks.paste.mockResolvedValueOnce({ kind: "image", dataB64: "QUJD", ext: "png" });
		mocks.saveAttachments.mockResolvedValueOnce(["/saved/image.png"]);
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
		await screen.findByText(/pasted-.*\.png/);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
		expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({
			projectId: homeProject.id, promptText: "", attachmentPaths: ["/saved/image.png"], useWorktree: false,
		}));
	});

	it("keeps a home-folder failure retryable and coalesces repeated submissions", async () => {
		useStore.setState({ projects: [] });
		mocks.homeDir.mockRejectedValueOnce(new Error("Home unavailable"));
		const onClose = vi.fn();
		render(<QuickDispatchOverlay open onClose={onClose} prefill={{ promptText: "Plan my day", projectId: "", typedName: "" }} />);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await screen.findByText("Error: Home unavailable");
		expect(onClose).not.toHaveBeenCalled();
		expect(mocks.begin).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
		expect(mocks.ensureProject).toHaveBeenCalledOnce();
	});

	it.each(["close", "project"])("cancels home resolution after changing %s", async (change) => {
		let finish!: (path: string) => void;
		mocks.homeDir.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		const view = render(<QuickDispatchOverlay open onClose={vi.fn()} prefill={{ promptText: "Plan my day", projectId: "", typedName: "" }} />);
		openSelect(screen.getByRole("combobox", { name: t("agents.quickDispatch.projectLabel") }));
		fireEvent.click(screen.getByRole("option", { name: t("agents.quickDispatch.noProject") }));
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		if (change === "close") view.rerender(<QuickDispatchOverlay open={false} onClose={vi.fn()} />);
		else {
			openSelect(screen.getByRole("combobox", { name: t("agents.quickDispatch.projectLabel") }));
			fireEvent.click(screen.getByRole("option", { name: repo.name }));
		}
		await act(async () => { finish(homeProject.path); });
		expect(mocks.ensureProject).not.toHaveBeenCalled();
		expect(mocks.begin).not.toHaveBeenCalled();
	});

	it("does not silently use local home for an unmatched SSH context", () => {
		useStore.setState({ focusCtx: { source: "ssh", hostId: "missing", cwd: "/repo", label: "remote" } });
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(mocks.homeDir).not.toHaveBeenCalled();
	});

	it("can return from no project to an SSH project without registering local home", async () => {
		const host = { id: "remote", name: "Build", host: "build.test", user: "dev", port: 22, auth: "auto" as const };
		const remote = { ...repo, id: "remote-project", kind: "ssh" as const, sshHostId: host.id };
		useStore.setState({ projects: [remote], sshHosts: [host] });
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		const select = () => openSelect(screen.getByRole("combobox", { name: t("agents.quickDispatch.projectLabel") }));
		select();
		fireEvent.click(screen.getByRole("option", { name: t("agents.quickDispatch.noProject") }));
		select();
		fireEvent.click(screen.getByRole("option", { name: "Build · repo" }));
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Remote task" } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
		expect(mocks.homeDir).not.toHaveBeenCalled();
		expect(mocks.ensureProject).not.toHaveBeenCalled();
		expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({ projectId: remote.id, remoteTarget: expect.objectContaining({ hostId: host.id }) }));
	});

	it("waits for an in-flight image paste before dispatching text", async () => {
		let finish!: (value: { kind: string; dataB64: string; ext: string }) => void;
		mocks.paste.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		mocks.saveAttachments.mockResolvedValueOnce(["/saved/image.png"]);
		render(<QuickDispatchOverlay open onClose={vi.fn()} prefill={{ projectId: repo.id, promptText: "Describe this image", typedName: "" }} />);
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await act(async () => { finish({ kind: "image", dataB64: "QUJD", ext: "png" }); });
		expect(mocks.begin).toHaveBeenCalledTimes(1);
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ promptText: "Describe this image", attachmentPaths: ["/saved/image.png"] });
	});

	it("repeated Enter saves an attached submission only once", async () => {
		mocks.paste.mockResolvedValueOnce({ kind: "image", dataB64: "QUJD", ext: "png" });
		let finish!: (value: string[]) => void;
		mocks.saveAttachments.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
		await screen.findByText(/pasted-.*\.png/);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await act(async () => { finish(["/saved/image.png"]); });
		expect(mocks.saveAttachments).toHaveBeenCalledTimes(1);
		mocks.saveAttachments.mockResolvedValue([]);
	});

	it.each(["paste", "save"])("cancels %s submission across close and reopen", async (stage) => {
		let finishPaste!: (value: { kind: string; dataB64: string; ext: string }) => void;
		let finishSave!: (value: string[]) => void;
		mocks.paste.mockReturnValueOnce(new Promise((resolve) => { finishPaste = resolve; }));
		mocks.saveAttachments.mockReturnValueOnce(new Promise((resolve) => { finishSave = resolve; }));
		const onClose = vi.fn();
		const view = render(<QuickDispatchOverlay open onClose={onClose} prefill={{ promptText: "Describe", projectId: repo.id, typedName: "" }} />);
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
		if (stage === "save") await act(async () => { finishPaste({ kind: "image", dataB64: "QUJD", ext: "png" }); });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		view.rerender(<QuickDispatchOverlay open={false} onClose={onClose} />);
		view.rerender(<QuickDispatchOverlay open onClose={onClose} />);
		await act(async () => {
			if (stage === "paste") finishPaste({ kind: "image", dataB64: "QUJD", ext: "png" });
			else finishSave(["/saved/image.png"]);
		});
		expect(mocks.begin).not.toHaveBeenCalled();
		expect(mocks.run).not.toHaveBeenCalled();
		mocks.saveAttachments.mockReset().mockResolvedValue([]);
	});

	it("waits for an image-only drop and coalesces repeated Enter", async () => {
		let finish!: (bytes: ArrayBuffer) => void;
		const file = { name: "image.png", size: 3, arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }) };
		mocks.saveAttachments.mockResolvedValueOnce(["/saved/image.png"]);
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		fireEvent.drop(screen.getByRole("textbox"), { dataTransfer: { types: ["Files"], files: [file] } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		expect(mocks.begin).not.toHaveBeenCalled();
		await act(async () => { finish(new Uint8Array([1, 2, 3]).buffer); });
		expect(mocks.saveAttachments).toHaveBeenCalledTimes(1);
		expect(mocks.begin).toHaveBeenCalledTimes(1);
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ promptText: "", attachmentPaths: ["/saved/image.png"] });
	});

	it("keeps a failed attachment save retryable without sending twice", async () => {
		mocks.paste.mockResolvedValueOnce({ kind: "image", dataB64: "QUJD", ext: "png" });
		mocks.saveAttachments.mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValueOnce(["/saved/image.png"]);
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
		await screen.findByText(/pasted-.*\.png/);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await screen.findByText("Error: disk unavailable");
		expect(mocks.begin).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(mocks.begin).toHaveBeenCalledTimes(1));
		expect(mocks.run).toHaveBeenCalledTimes(1);
	});

	it.each([{ shiftKey: true }, { isComposing: true }])("does not queue modified Enter during image capture (%j)", async (modifiers) => {
		let finish!: (value: { kind: string; dataB64: string; ext: string }) => void;
		mocks.paste.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		render(<QuickDispatchOverlay open onClose={vi.fn()} prefill={{ promptText: "Describe", projectId: repo.id, typedName: "" }} />);
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ...modifiers });
		await act(async () => { finish({ kind: "image", dataB64: "QUJD", ext: "png" }); });
		expect(mocks.begin).not.toHaveBeenCalled();
	});

	it("keeps the draft when a queued image capture cannot be read", async () => {
		let finish!: (value: null) => void;
		mocks.paste.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		render(<QuickDispatchOverlay open onClose={vi.fn()} prefill={{ promptText: "Describe", projectId: repo.id, typedName: "" }} />);
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await act(async () => { finish(null); });
		expect(screen.getByText(t("files.transfer.infoUnreadable"))).toBeTruthy();
		expect(mocks.begin).not.toHaveBeenCalled();
		expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Describe");
	});

	it.each([false, true])("journals the worktree toggle before dispatch (%s)", async (useWorktree) => {
		render(<QuickDispatchOverlay open onClose={vi.fn()} prefill={{ projectId: repo.id, promptText: "Fix this", typedName: "" }} />);
		const toggle = screen.getByRole("switch", { name: t("agents.worktree.isolateDedicated") });
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		if (useWorktree) fireEvent.click(toggle);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ useWorktree, runSetup: useWorktree });
		expect(mocks.run.mock.calls[0][0]).toMatchObject({ useWorktree });
	});

	it("disables worktree and setup for a non-repository folder", () => {
		useStore.setState({ projects: [{ ...repo, isRepo: false }] });
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		expect((screen.getByRole("switch", { name: t("agents.worktree.isolateDedicated") }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: t("common.advanced") }));
		expect((screen.getByRole("switch", { name: t("agents.worktree.runSetupAfterCreate") }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("resets provider-scoped permissions and does not offer unsupported modes after a provider change", async () => {
		useStore.setState({ installedAgents: ["pi"] });
		render(<QuickDispatchOverlay open onClose={vi.fn()} prefill={{ projectId: repo.id, promptText: "Keep draft", typedName: "" }} />);
		fireEvent.click(screen.getByRole("button", { name: t("common.advanced") }));
		await choosePermission(t("agents.chat.permissionSkip"));
		expect(screen.getByText(t("agents.permission.bypassHint"))).toBeTruthy();
		openSelect(screen.getByRole("combobox", { name: t("agents.quickDispatch.agentLabel") }));
		fireEvent.click(await screen.findByRole("option", { name: "Pi" }));
		openPermissions();
		const inherited = await screen.findByRole("option", { name: t("common.systemDefault") });
		expect(inherited.getAttribute("data-state")).toBe("checked");
		expect(screen.queryByRole("option", { name: t("agents.chat.permissionAutoEdit") })).toBeNull();
		expect(screen.queryByRole("option", { name: t("agents.chat.permissionSkip") })).toBeNull();
		expect(screen.getByText(t("agents.permission.inheritHint"))).toBeTruthy();
		fireEvent.keyDown(inherited, { key: "Escape" });
		fireEvent.click(screen.getByRole("button", { name: t("agents.quickDispatch.startAgent") }));
		await waitFor(() => expect(mocks.begin).toHaveBeenCalledTimes(1));
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ providerId: "pi", permissionOverride: undefined, promptText: "Keep draft" });
	});

	it("dispatches the selected auto-edit permission without converting it to approvals or bypass", async () => {
		render(<QuickDispatchOverlay open onClose={vi.fn()} prefill={{ projectId: repo.id, promptText: "Review safely", typedName: "" }} />);
		fireEvent.click(screen.getByRole("button", { name: t("common.advanced") }));
		await choosePermission(t("agents.chat.permissionAutoEdit"));
		fireEvent.click(screen.getByRole("button", { name: t("agents.quickDispatch.startAgent") }));
		await waitFor(() => expect(mocks.begin).toHaveBeenCalledTimes(1));
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ permissionOverride: "auto_edit" });
	});

	it("retires a pending paste when the overlay closes before reopening", async () => {
		let finish!: (value: { kind: string; dataB64: string; ext: string }) => void;
		mocks.paste.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		const onClose = vi.fn();
		const view = render(<QuickDispatchOverlay open onClose={onClose} />);
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
		view.rerender(<QuickDispatchOverlay open={false} onClose={onClose} />);
		await act(async () => { finish({ kind: "image", dataB64: "QUJD", ext: "png" }); });
		view.rerender(<QuickDispatchOverlay open onClose={onClose} />);
		expect(screen.queryByText(/pasted-.*\.png/)).toBeNull();
	});

	it("retains a pasted attachment for the existing journaled submission", async () => {
		mocks.paste.mockResolvedValueOnce({ kind: "image", dataB64: "QUJD", ext: "png" });
		mocks.saveAttachments.mockResolvedValueOnce(["/saved/image.png"]);
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
		await screen.findByText(/pasted-.*\.png/);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(mocks.begin).toHaveBeenCalledTimes(1));
		expect(mocks.saveAttachments).toHaveBeenCalledWith("qd_1", [{ fileName: expect.stringMatching(/pasted-.*\.png/), dataB64: "QUJD" }]);
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ promptText: "", attachmentPaths: ["/saved/image.png"] });
	});
	it.each(["basic", "pro"] as const)("keeps advanced choices and the draft across collapse in %s mode", async (interfaceMode) => {
		useStore.getState().setUiPrefs({ interfaceMode });
		render(<QuickDispatchOverlay open onClose={vi.fn()} prefill={{ projectId: repo.id, promptText: "Keep my draft", typedName: "" }} />);
		fireEvent.click(screen.getByRole("switch", { name: t("agents.worktree.isolateDedicated") }));
		expect(screen.getByRole("button", { name: t("common.advanced") }).getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(screen.getByRole("button", { name: t("common.advanced") }));
		await choosePermission(t("agents.chat.permissionDefault"));
		fireEvent.click(screen.getByRole("switch", { name: t("agents.worktree.runSetupAfterCreate") }));
		fireEvent.click(screen.getByRole("button", { name: t("common.advanced") }));
		expect(mocks.begin).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: t("common.advanced") }));
		openPermissions();
		const selected = await screen.findByRole("option", { name: t("agents.chat.permissionDefault") });
		expect(selected.getAttribute("data-state")).toBe("checked");
		fireEvent.keyDown(selected, { key: "Escape" });
		expect(screen.getByRole("switch", { name: t("agents.worktree.runSetupAfterCreate") }).getAttribute("aria-checked")).toBe("false");
		expect(screen.getByRole("combobox", { name: new RegExp(t("agents.quickDispatch.modelLabel")) })).toBeTruthy();
		expect(mocks.catalog).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: t("agents.quickDispatch.startAgent") }));
		await waitFor(() => expect(mocks.begin).toHaveBeenCalledTimes(1));
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ promptText: "Keep my draft", permissionOverride: "require_approvals", runSetup: false });
	});

	it("starts a nonempty request through the same journal from the primary action", async () => {
		const onClose = vi.fn();
		render(<QuickDispatchOverlay open onClose={onClose} prefill={{ projectId: repo.id, promptText: "", typedName: "design-review" }} />);
		const start = screen.getByRole("button", { name: t("agents.quickDispatch.startAgent") }) as HTMLButtonElement;
		expect(start.disabled).toBe(true);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: " \n\t " } });
		expect(start.disabled).toBe(true);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Review the compose surface  " } });
		expect(start.disabled).toBe(false);
		fireEvent.click(start);
		await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
		expect(mocks.begin).toHaveBeenCalledTimes(1);
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ projectId: repo.id, promptText: "  Review the compose surface  ", typedName: "design-review" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])("inserts a saved prompt at the selection without dispatching (appendEnter=%s)", async (appendEnter) => {
		const command = { id: "review", label: "Review architecture", text: "Review\n  preserve whitespace\n", appendEnter };
		useStore.getState().setUiPrefs({ quickCommands: [command] });
		render(<QuickDispatchOverlay open onClose={vi.fn()} prefill={{ projectId: repo.id, promptText: "Before REPLACE after", typedName: "review-work" }} />);
		const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
		composer.focus();
		composer.setSelectionRange(7, 14);
		fireEvent.pointerDown(screen.getByRole("button", { name: t("workspace.quickCommands.menu") }), { button: 0, ctrlKey: false, pointerType: "mouse" });
		fireEvent.click(await screen.findByRole("menuitem", { name: command.label }));
		await waitFor(() => expect(document.activeElement).toBe(composer));
		expect(composer.value).toBe(`Before ${command.text} after`);
		expect(composer.selectionStart).toBe(7 + command.text.length);
		expect(composer.selectionEnd).toBe(composer.selectionStart);
		expect(mocks.begin).not.toHaveBeenCalled();
		expect(mocks.run).not.toHaveBeenCalled();
		expect(useStore.getState().uiPrefs.quickCommands).toEqual([command]);
		fireEvent.change(composer, { target: { value: `${composer.value}\nExtra context` } });
		fireEvent.keyDown(composer, { key: "Enter" });
		await waitFor(() => expect(mocks.begin).toHaveBeenCalledTimes(1));
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ projectId: repo.id, promptText: `Before ${command.text} after\nExtra context`, typedName: "review-work" });
		expect(mocks.run).toHaveBeenCalledTimes(1);
	});

	it("cancels the saved-prompt menu without changing the draft or its selection", async () => {
		useStore.getState().setUiPrefs({ quickCommands: [{ id: "next", label: "Next task", text: "Next task", appendEnter: true }] });
		render(<QuickDispatchOverlay open onClose={vi.fn()} prefill={{ projectId: repo.id, promptText: "Keep this draft", typedName: "" }} />);
		const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
		composer.focus();
		composer.setSelectionRange(5, 9);
		const trigger = screen.getByRole("button", { name: t("workspace.quickCommands.menu") });
		trigger.focus();
		fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
		fireEvent.keyDown(await screen.findByRole("menuitem", { name: "Next task" }), { key: "Escape" });
		await waitFor(() => expect(document.activeElement).toBe(composer));
		expect(composer.value).toBe("Keep this draft");
		expect(composer.selectionStart).toBe(5);
		expect(composer.selectionEnd).toBe(9);
		expect(mocks.begin).not.toHaveBeenCalled();
	});

	it("reads live saved prompts and inserts with the keyboard before explicit submission", async () => {
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
		const trigger = screen.getByRole("button", { name: t("workspace.quickCommands.menu") });
		trigger.focus();
		fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
		expect((await screen.findByRole("menuitem", { name: t("workspace.quickCommands.empty") })).getAttribute("aria-disabled")).toBe("true");
		act(() => useStore.getState().setUiPrefs({ quickCommands: [
			{ id: "next", label: "Next task", text: "Latest saved prompt", appendEnter: true },
			{ id: "review", label: "Review", text: "Review only", appendEnter: false },
		] }));
		const item = await screen.findByRole("menuitem", { name: "Next task" });
		expect(screen.queryByRole("menuitem", { name: t("workspace.quickCommands.empty") })).toBeNull();
		act(() => useStore.getState().setUiPrefs({ quickCommands: moveQuickCommand(useStore.getState().uiPrefs.quickCommands ?? [], "review", -1) }));
		expect(screen.getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual(["Review", "Next task"]);
		expect(composer.value).toBe("");
		expect(mocks.begin).not.toHaveBeenCalled();
		item.focus();
		fireEvent.keyDown(item, { key: "Enter", code: "Enter" });
		await waitFor(() => expect(document.activeElement).toBe(composer));
		expect(composer.value).toBe("Latest saved prompt");
		expect(mocks.begin).not.toHaveBeenCalled();
		fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
		expect(mocks.begin).not.toHaveBeenCalled();
		fireEvent.keyDown(composer, { key: "Enter" });
		await waitFor(() => expect(mocks.begin).toHaveBeenCalledTimes(1));
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ promptText: "Latest saved prompt" });
	});

	it("submits the visible textarea text for a saved prompt with CRLF line endings", async () => {
		useStore.getState().setUiPrefs({ quickCommands: [
			{ id: "windows", label: "Windows prompt", text: "Review\r\n  preserve whitespace\r\nThen test", appendEnter: false },
		] });
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		fireEvent.pointerDown(screen.getByRole("button", { name: t("workspace.quickCommands.menu") }), { button: 0, ctrlKey: false, pointerType: "mouse" });
		fireEvent.click(await screen.findByRole("menuitem", { name: "Windows prompt" }));
		const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
		await waitFor(() => expect(document.activeElement).toBe(composer));
		expect(composer.value).toBe("Review\n  preserve whitespace\nThen test");
		fireEvent.keyDown(composer, { key: "Enter" });
		await waitFor(() => expect(mocks.begin).toHaveBeenCalledTimes(1));
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ promptText: composer.value });
	});

	it("leaves focus on a parameter clicked outside the saved-prompt menu", async () => {
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: t("common.advanced") }));
		fireEvent.pointerDown(screen.getByRole("button", { name: t("workspace.quickCommands.menu") }), { button: 0, ctrlKey: false, pointerType: "mouse" });
		await screen.findByRole("menu");
		const name = screen.getByRole("button", { name: new RegExp(t("agents.quickDispatch.nameLabel")) });
		fireEvent.pointerDown(name, { button: 0, ctrlKey: false, pointerType: "mouse" });
		fireEvent.click(name);
		// Flush Radix FocusScope's deferred unmount autofocus, not just the click render.
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		expect(document.activeElement).toBe(screen.getByPlaceholderText(t("agents.quickDispatch.nameAuto")));
		expect(mocks.begin).not.toHaveBeenCalled();
	});

	it("discovers a selected credential's models on open and journals its exact model and effort", async () => {
		useStore.setState({
			accounts: [claudeWork],
			uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "pro" },
		});
		mocks.catalog.mockResolvedValue([{
			value: "provider-next[1m]", displayName: "Provider Next",
			supportsEffort: true, supportedEffortLevels: ["deeper"],
		}]);
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		expect(mocks.catalog).not.toHaveBeenCalled();
		const open = (label: string) => openSelect(screen.getByRole("combobox", { name: new RegExp(label) }));
		open(t("agents.account.credential"));
		fireEvent.click(await screen.findByRole("option", { name: claudeWork.name }));
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", {
			name: t("agents.account.credential"),
		})));
		fireEvent.click(screen.getByRole("button", { name: t("common.advanced") }));
		open(t("agents.quickDispatch.modelLabel"));
		fireEvent.click(await screen.findByRole("option", { name: "Provider Next" }));
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", {
			name: t("agents.quickDispatch.modelLabel"),
		})));
		expect(mocks.catalog).toHaveBeenLastCalledWith({
			providerId: "claude", profileId: "local",
			credentialProfile: { referenceId: claudeWork.id, profileDirectoryName: "claude-work" },
		});
		open(t("agents.quickDispatch.effortLabel"));
		fireEvent.click(await screen.findByRole("option", { name: "Deeper" }));
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "use the discovered model" } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(mocks.begin).toHaveBeenCalled());
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({
			accountId: claudeWork.id, model: "provider-next[1m]", effort: "deeper",
		});
	});

	it("Enter records the intent, closes, and starts the run", async () => {
		const onClose = vi.fn();
		const onDispatched = vi.fn();
		render(
			<QuickDispatchOverlay
				open
				onClose={onClose}
				onDispatched={onDispatched}
			/>,
		);
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "fix the flicker" },
		});
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(mocks.begin).toHaveBeenCalled());
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({
			promptText: "fix the flicker",
			accountId: null,
		});
		// The dispatched acknowledgment fires only once the intent is durable,
		// so the launcher's confirmation pill can never announce a submit that
		// was rejected before journaling.
		expect(onDispatched).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
		expect(mocks.run).toHaveBeenCalled();
	});

	it("snapshots the active account when opened, even if the global selection later changes", async () => {
		useStore.setState({ accounts: [claudeWork], activeAccounts: { claude: claudeWork.id } });
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		expect(screen.getByRole("combobox", { name: t("agents.account.credential") }).textContent).toBe(claudeWork.name);
		act(() => useStore.setState({ activeAccounts: {} }));
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "use selected account" } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(mocks.begin).toHaveBeenCalled());
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ accountId: claudeWork.id });
	});

	it("preserves an explicit default override and snapshots the next provider's active account", async () => {
		useStore.setState({ accounts: [claudeWork, codexPersonal], activeAccounts: { claude: claudeWork.id, codex: codexPersonal.id } });
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		openSelect(screen.getByRole("combobox", { name: t("agents.account.credential") }));
		fireEvent.click(await screen.findByRole("option", { name: t("agents.account.defaultCli") }));
		act(() => useStore.setState({ activeAccounts: { claude: claudeWork.id, codex: codexPersonal.id } }));
		expect(screen.getByRole("combobox", { name: t("agents.account.credential") }).textContent).toBe(t("agents.quickDispatch.defaultAccount"));
		openSelect(screen.getByRole("combobox", { name: t("agents.quickDispatch.agentLabel") }));
		fireEvent.click(await screen.findByRole("option", { name: "Codex" }));
		expect(screen.getByRole("combobox", { name: t("agents.account.credential") }).textContent).toBe(codexPersonal.name);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "use codex account" } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(mocks.begin).toHaveBeenCalled());
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({ providerId: "codex", accountId: codexPersonal.id });
	});

	it("pins a provider-scoped credential selected with the keyboard", async () => {
		useStore.setState({
			accounts: [claudeWork, codexPersonal],
			activeAccounts: { claude: claudeWork.id },
		});
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);

		const credentialTrigger = screen.getByRole("combobox", {
			name: t("agents.account.credential"),
		});
		credentialTrigger.focus();
		openSelect(credentialTrigger);
		const workProfile = await screen.findByRole("option", {
			name: claudeWork.name,
		});
		expect(screen.queryByText(codexPersonal.name)).toBeNull();
		fireEvent.keyDown(workProfile, { key: "Enter", code: "Enter" });

		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "use the work credential" },
		});
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

		await waitFor(() => expect(mocks.begin).toHaveBeenCalled());
		expect(mocks.begin.mock.calls[0][0]).toMatchObject({
			providerId: "claude",
			accountId: claudeWork.id,
		});
	});

	it("resets the credential when the provider changes", async () => {
		useStore.setState({ accounts: [claudeWork, codexPersonal] });
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);

		openSelect(screen.getByRole("combobox", {
				name: new RegExp(t("agents.account.credential")),
			}));
		fireEvent.click(
			await screen.findByRole("option", { name: claudeWork.name }),
		);
		openSelect(screen.getByRole("combobox", {
				name: new RegExp(t("agents.quickDispatch.agentLabel")),
				expanded: false,
			}));
		fireEvent.click(
			await screen.findByRole("option", { name: "Claude Code" }),
		);
		expect(
			screen.getByRole("combobox", {
				name: t("agents.account.credential"),
			}).textContent,
		).toBe(claudeWork.name);

		openSelect(screen.getByRole("combobox", {
				name: new RegExp(t("agents.quickDispatch.agentLabel")),
				expanded: false,
			}));
		fireEvent.click(await screen.findByText("Codex"));

		const credentialTrigger = screen.getByRole("combobox", {
			name: t("agents.account.credential"),
		});
		expect(credentialTrigger.textContent).toBe(t("agents.quickDispatch.defaultAccount"));
		openSelect(credentialTrigger);
		expect(
			await screen.findByRole("option", {
				name: codexPersonal.name,
			}),
		).toBeTruthy();
		expect(screen.queryByText(claudeWork.name)).toBeNull();
	});

	it("does not offer profiles unsupported by the canonical backend", async () => {
		useStore.setState({
			accounts: [
				{
					id: "acc-kimi-work",
					provider: "kimi",
					name: "Kimi work",
					dir: "/accounts/kimi-work",
				},
			],
		});
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);

		openSelect(screen.getByRole("combobox", {
				name: new RegExp(t("agents.quickDispatch.agentLabel")),
				expanded: false,
			}));
		fireEvent.click(await screen.findByText("Kimi Code"));

		expect(
			screen.queryByRole("combobox", {
				name: new RegExp(t("agents.account.credential")),
			}),
		).toBeNull();
	});

	it("Shift+Enter inserts a newline instead of submitting", () => {
		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		fireEvent.keyDown(screen.getByRole("textbox"), {
			key: "Enter",
			shiftKey: true,
		});
		expect(mocks.begin).not.toHaveBeenCalled();
	});

	it.each(["pending", "failed"] as const)("retries the exact %s intent instead of minting another action", async (state) => {
		const pending: QuickDispatchIntentV1 = {
			schemaVersion: 1,
			intentId: "qd_11111111111111111111111111111111",
			createdAtMs: 1,
			promptText: "fix the flicker",
			attachmentPaths: [],
			projectId: repo.id,
			providerId: "claude",
			model: null,
			typedName: null,
			resolvedName: "fix-the-flicker",
			resolvedBaseSha: "a".repeat(40),
			state,
		};
		mocks.journal.intents = [pending];
		mocks.run.mockImplementationOnce(async () => {
			mocks.journal.intents = [];
		});

		render(<QuickDispatchOverlay open onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: t("common.retry") }));

		await waitFor(() => expect(mocks.run).toHaveBeenCalledWith(pending));
		expect(mocks.begin).not.toHaveBeenCalled();
		expect(mocks.newId).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: t("common.retry") }),
			).toBeNull(),
		);
	});

	it("pre-selects the stored default agent, and Auto keeps today's first provider", () => {
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, defaultProvider: "codex" as const },
		}));
		const { unmount } = render(
			<QuickDispatchOverlay open onClose={vi.fn()} onDispatched={vi.fn()} />,
		);
		// The picker trigger shows the selected provider's label; the dropdown
		// items are not in the DOM until opened, so this text is the trigger.
		expect(screen.getByText("Codex")).toBeTruthy();
		unmount();

		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, defaultProvider: undefined },
		}));
		render(
			<QuickDispatchOverlay open onClose={vi.fn()} onDispatched={vi.fn()} />,
		);
		expect(screen.getByText("Claude Code")).toBeTruthy();
	});

	it("uses a GitHub row prefill as the initial project, prompt, and name", () => {
		useStore.setState({
			projects: [
				{
					id: "project-2",
					name: "Other",
					path: "/work/other",
					kind: "local",
					isRepo: true,
				},
				{
					id: "project-1",
					name: "Dure",
					path: "/work/dure",
					kind: "local",
					isRepo: true,
				},
			],
		});
		render(
			<QuickDispatchOverlay
				open
				prefill={{
					projectId: "project-1",
					promptText: "Work on GitHub issue #42",
					typedName: "github-issue-42",
				}}
				onClose={vi.fn()}
			/>,
		);

		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"Work on GitHub issue #42",
		);
		expect(screen.getByText("Dure")).toBeTruthy();
		expect(screen.getByText("github-issue-42")).toBeTruthy();
	});
});


it("composes and submits from focused SSH without consulting the local catalog", async () => {
 const host = { id: "remote", name: "Build", host: "build.test", user: "dev", port: 22, auth: "auto" as const };
 const remote = { ...repo, id: "remote-project", kind: "ssh" as const, sshHostId: host.id };
 useStore.setState({ projects: [repo, remote], sshHosts: [host], focusCtx: { source: "ssh", hostId: host.id, cwd: "/repo/src", label: "remote" } });
 render(<QuickDispatchOverlay open onClose={() => {}} />);
 expect(screen.getByRole("combobox", { name: t("agents.quickDispatch.projectLabel") }).textContent).toContain("Build · repo");
 fireEvent.change(screen.getByRole("textbox"), { target: { value: "Remote task" } });
 fireEvent.click(screen.getByRole("button", { name: t("agents.quickDispatch.startAgent") }));
 await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
 expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({ projectId: remote.id, remoteTarget: expect.objectContaining({ hostId: host.id, path: repo.path, host: host.host }) }));
 expect(mocks.catalog).not.toHaveBeenCalled();
});


it("uploads SSH attachments and preserves explicit remote model and effort", async () => {
 const host = { id: "remote", name: "Build", host: "build.test", user: "dev", port: 22, auth: "auto" as const };
 const remote = { ...repo, id: "remote-project", kind: "ssh" as const, sshHostId: host.id };
 useStore.setState({ projects: [remote], sshHosts: [host], focusCtx: { source: "ssh", hostId: host.id, cwd: "/repo", label: "remote" } });
 mocks.paste.mockResolvedValueOnce({ kind: "image", dataB64: "QUJD", ext: "png" });
 render(<QuickDispatchOverlay open onClose={() => {}} />);
 fireEvent.change(screen.getByRole("textbox"), { target: { value: "Remote task" } });
 fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
 await screen.findByText(/pasted-.*\.png/);
 fireEvent.click(screen.getByRole("button", { name: t("common.advanced") }));
 for (const [key, value] of [["agents.quickDispatch.modelLabel", "provider/model"], ["agents.quickDispatch.effortLabel", "high"]] as const) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(t(key)) }));
  const input = screen.getByRole("textbox", { name: t(key) });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
 }
 fireEvent.click(screen.getByRole("button", { name: t("agents.quickDispatch.startAgent") }));
 await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
 expect(mocks.saveRemote).toHaveBeenCalledWith(host.id, [expect.objectContaining({ dataB64: "QUJD" })]);
 expect(mocks.saveAttachments).not.toHaveBeenCalled();
 expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({ model: "provider/model", effort: "high", attachmentPaths: ["/tmp/remote/image.png"] }));
});

it("keeps an invalid SSH model draft open without uploading or journaling", () => {
 const host = { id: "remote", name: "Build", host: "build.test", user: "dev", port: 22, auth: "auto" as const };
 useStore.setState({ projects: [{ ...repo, kind: "ssh", sshHostId: host.id }], sshHosts: [host] });
 render(<QuickDispatchOverlay open onClose={() => {}} />);
 fireEvent.change(screen.getByRole("textbox"), { target: { value: "Remote task" } });
 fireEvent.click(screen.getByRole("button", { name: t("common.advanced") }));
 fireEvent.click(screen.getByRole("button", { name: new RegExp(t("agents.quickDispatch.modelLabel")) }));
 const input = screen.getByRole("textbox", { name: t("agents.quickDispatch.modelLabel") });
 fireEvent.change(input, { target: { value: "invalid model" } });
 fireEvent.keyDown(input, { key: "Enter" });
 fireEvent.click(screen.getByRole("button", { name: t("agents.quickDispatch.startAgent") }));
 expect(screen.getByText(t("agents.quickDispatch.invalidSelection"))).toBeTruthy();
 expect(mocks.begin).not.toHaveBeenCalled();
 expect(mocks.saveRemote).not.toHaveBeenCalled();
});

it("drops a selected Pro provider on Basic switch before submitting the retained draft", async () => {
	useStore.setState({
		installedAgents: ["gemini"],
		uiPrefs: { ...useStore.getState().uiPrefs, defaultProvider: "gemini" },
	});
	render(
		<QuickDispatchOverlay
			open
			onClose={vi.fn()}
			prefill={{ projectId: repo.id, promptText: "Keep this task", typedName: "" }}
		/>,
	);
	expect(
		screen.getByRole("combobox", { name: t("agents.quickDispatch.agentLabel") })
			.textContent,
	).toContain("Gemini CLI");
	act(() =>
		useStore.setState({
			uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "basic" },
		}),
	);
	expect(
		screen.getByRole("combobox", { name: t("agents.quickDispatch.agentLabel") })
			.textContent,
	).toContain("Claude Code");
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.quickDispatch.startAgent") }),
	);
	await waitFor(() => expect(mocks.begin).toHaveBeenCalled());
	expect(mocks.begin.mock.calls[0][0]).toMatchObject({
		providerId: "claude",
		promptText: "Keep this task",
	});
});

it.each(["basic", "pro"] as const)(
	"applies %s rollout to SSH options independently of local installation",
	async (interfaceMode) => {
		useStore.setState({
			uiPrefs: {
				...useStore.getState().uiPrefs,
				interfaceMode,
				defaultProvider: "gemini",
			},
			projects: [{ ...repo, kind: "ssh", sshHostId: "ssh-1" }],
			sshHosts: [
				{
					id: "ssh-1",
					name: "Remote",
					host: "remote.test",
					port: 22,
					user: "qa",
					auth: "auto",
				},
			],
		});
		render(
			<QuickDispatchOverlay
				open
				onClose={vi.fn()}
				prefill={{ projectId: repo.id, promptText: "", typedName: "" }}
			/>,
		);
		openSelect(
			screen.getByRole("combobox", {
				name: t("agents.quickDispatch.agentLabel"),
			}),
		);
		await screen.findByRole("option", { name: "Claude Code" });
		expect(Boolean(screen.queryByRole("option", { name: "Gemini CLI" }))).toBe(
			interfaceMode === "pro",
		);
	},
);
