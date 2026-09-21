// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { remoteHmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { enqueueDesktopCloseMutation } from "@/lib/workspace/layout/closeMutationQueue";
import { closePanelById } from "@/lib/workspace/pane/paneCloseCoordinator";
import { useStore } from "@/store";

const remote = vi.hoisted(() => ({ resolve: vi.fn(), depart: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("@/lib/hmux/remote/remoteHmuxControllerResolution", () => ({
	resolveRemoteHmuxStandaloneController: remote.resolve,
}));
vi.mock("@/lib/ipc", async (original) => ({
	...(await original<object>()),
	remoteHmuxDepartGracefully: remote.depart,
}));

const desktopId = "remote-close";
const cleanups: Array<() => void> = [];
const preserved = {
	state: "session_preserved",
	reason: "other_clients_attached",
};
const params = (sessionId: string) => ({
	sessionId,
	binding: remoteHmuxStandaloneBinding(sessionId, "workspace", "host", "nonce"),
});

function mounted() {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	registerDockview(desktopId, api);
	const panel = api.addPanel({
		id: "ssh-pane",
		component: "terminal",
		params: params("original"),
	});
	useStore.setState({ layouts: { [desktopId]: api.toJSON() } });
	cleanups.push(() => {
		unregisterDockview(desktopId, api);
		api.dispose();
		container.remove();
	});
	return { api, panel };
}

beforeEach(() => {
	remote.resolve.mockReset().mockImplementation(async (_hosts, binding) => ({
		target: { hostId: binding.hostId },
		session: { sessionId: binding.sessionId, workspaceId: binding.workspaceId },
	}));
	remote.depart.mockReset().mockResolvedValue(preserved);
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	localStorage.clear();
	useStore.setState({ layouts: {} });
	vi.restoreAllMocks();
});

it("shares one SSH departure and successful close across repeated requests", async () => {
	const { api, panel } = mounted();
	const remove = vi.spyOn(api, "removePanel");
	let release!: () => void;
	remote.depart.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = () => resolve(preserved);
			}),
	);
	const first = Promise.allSettled([
		closePanelById(panel.id, desktopId),
		closePanelById(panel.id, desktopId),
	]);
	await vi.waitFor(() => expect(remote.depart).toHaveBeenCalledOnce());
	const repeated = Promise.allSettled([closePanelById(panel.id, desktopId)]);
	release();
	const results = [...(await first), ...(await repeated)];
	for (const result of results)
		expect(result).toMatchObject({
			status: "fulfilled",
			value: { desktopId, mode: "live", departure: preserved },
		});
	expect(remote.resolve).toHaveBeenCalledOnce();
	expect(remote.depart).toHaveBeenCalledOnce();
	expect(remove).toHaveBeenCalledOnce();
	expect(api.getPanel(panel.id)).toBeUndefined();
	expect(useStore.getState().layouts[desktopId]).toMatchObject({ panels: {} });
});

it("does not share a stale close result with an explicitly closed replacement binding", async () => {
	const { api, panel } = mounted();
	let release!: () => void;
	remote.depart.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = () => resolve(preserved);
			}),
	);
	const first = Promise.allSettled([closePanelById(panel.id, desktopId)]);
	await vi.waitFor(() => expect(remote.depart).toHaveBeenCalledOnce());
	panel.api.updateParameters(params("replacement"));
	const replacement = closePanelById(panel.id, desktopId);
	release();
	expect(await first).toMatchObject([
		{ status: "rejected", reason: { code: "pane_changed" } },
	]);
	await expect(replacement).resolves.toMatchObject({ desktopId, mode: "live" });
	expect(remote.depart).toHaveBeenCalledTimes(2);
	expect(remote.depart.mock.calls[1][1]).toMatchObject({
		sessionId: "replacement",
	});
	expect(api.getPanel(panel.id)).toBeUndefined();
});

it("preserves a binding replaced while its close waits behind another desktop mutation", async () => {
	const { api, panel } = mounted();
	let release!: () => void;
	const previous = enqueueDesktopCloseMutation(
		desktopId,
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const closing = Promise.allSettled([closePanelById(panel.id, desktopId)]);
	await vi.waitFor(() => expect(release).toBeTypeOf("function"));
	panel.api.updateParameters(params("replacement"));
	release();
	await previous;
	expect(await closing).toMatchObject([
		{ status: "rejected", reason: { code: "pane_changed" } },
	]);
	expect(remote.depart).not.toHaveBeenCalled();
	expect(api.getPanel(panel.id)?.params).toMatchObject(params("replacement"));
});
