// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MouseTrackingMode } from "@/contracts/terminalStateProtocol";
import { remoteHmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import { publishTerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocationStore";
import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";
import { StructuredTerminalView } from "./StructuredTerminalView";
import {
	deliverRecord,
	installAttachMock,
	mocks,
	registerStructuredTerminalView,
	renderTerminalView,
	resetStructuredTerminalHarness,
	restoreStructuredTerminalHarness,
	sentRecords,
	terminalViewport,
} from "./structuredTerminalTestHarness";

const links = vi.hoisted(() => ({
	openFileViewer: vi.fn(),
	openExternalUrl: vi.fn(async () => {}),
	openExternalPath: vi.fn(async () => {}),
	openBrowserPanelOn: vi.fn(),
	resolveHostRoute: vi.fn(
		async (
			hostId: string,
			hosts: readonly { id: string }[],
		): Promise<{ profileId: string } | undefined> =>
			hosts.some((host) => host.id === hostId)
				? { profileId: `profile-${hostId}` }
				: undefined,
	),
}));

vi.mock("@/lib/workspace/desktop/desktopPlatform", () => ({
	detectDesktopPlatform: () => "macos",
	isMacPlatform: () => true,
}));

vi.mock("@/lib/files/fileViewerPane", () => ({
	openFileViewer: links.openFileViewer,
}));

vi.mock("@/lib/workspace/dock/openBrowserPanel", () => ({
	openBrowserPanelOn: links.openBrowserPanelOn,
}));

vi.mock("@/lib/ipc/dureBackendProfiles", () => ({
	resolveSshHostDureBackendRouteAuthority: links.resolveHostRoute,
}));

vi.mock("@/lib/platform/externalOpen", () => ({
	openExternalUrl: links.openExternalUrl,
	openExternalPath: links.openExternalPath,
	isUserCancelledExternalOpen: () => false,
}));

vi.mock("@/components/workspace/WorkspaceRuntimeContext", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).workspaceRuntimeContextMockFactory(),
);

vi.mock("@/lib/workspace/window/largeViewReturnSourceRuntime", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).largeViewReturnSourceRuntimeMockFactory(),
);

vi.mock("@/lib/workspace/window/currentWindowFocus", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).currentWindowFocusMockFactory(),
);

vi.mock("@/lib/ipc", async () => ({
	...(await import("./structuredTerminalTestHarness")).ipcMockFactory(),
	homeDir: async () => "/Users/me",
}));

vi.mock("@/store", async () =>
	(await import("./structuredTerminalTestHarness")).storeMockFactory(),
);

vi.mock("@tauri-apps/plugin-clipboard-manager", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).clipboardManagerMockFactory(),
);

vi.mock("@/lib/toast", async () =>
	(await import("./structuredTerminalTestHarness")).toastMockFactory(),
);

vi.mock("@/components/terminal/TerminalViewChrome", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).terminalViewChromeMockFactory(),
);

vi.mock("./TerminalCanvasRenderer", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).terminalCanvasRendererMockFactory(),
);

registerStructuredTerminalView(StructuredTerminalView);

const DESKTOP = "desktop-links";
// Cells are 10px wide and 20px tall in the harness.
const at = (column: number, row = 0) => ({
	clientX: column * 10 + 5,
	clientY: row * 20 + 5,
});

beforeEach(() => {
	resetStructuredTerminalHarness();
	mocks.desktopId = DESKTOP;
	dockviewRegistry.set(DESKTOP, {} as DockviewApi);
	Object.assign(useStore.getState(), { sessionCwd: {} });
	for (const mock of Object.values(links)) mock.mockClear();
});

afterEach(() => {
	dockviewRegistry.delete(DESKTOP);
	restoreStructuredTerminalHarness();
});

async function bootWithText(
	texts: readonly string[],
	props: Parameters<typeof renderTerminalView>[0] = {},
	mouseTracking = MouseTrackingMode.NONE,
) {
	const onRecords = installAttachMock();
	const view = renderTerminalView(props);
	await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
	await deliverRecord(
		onRecords[0],
		viewportFrameRecord({ texts, mouseTracking }),
	);
	const viewport = terminalViewport(view.container);
	vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(
		new DOMRect(0, 0, 800, 20 * texts.length),
	);
	return viewport;
}

function click(
	viewport: HTMLElement,
	position: { clientX: number; clientY: number },
	modifiers: { metaKey?: boolean; shiftKey?: boolean } = { metaKey: true },
	release = position,
) {
	fireEvent.pointerDown(viewport, {
		pointerId: 31,
		button: 0,
		buttons: 1,
		...modifiers,
		...position,
	});
	fireEvent.pointerUp(viewport, {
		pointerId: 31,
		button: 0,
		buttons: 0,
		...modifiers,
		...release,
	});
}

function hover(
	viewport: HTMLElement,
	position: { clientX: number; clientY: number },
	modifiers: { metaKey?: boolean; shiftKey?: boolean } = { metaKey: true },
) {
	fireEvent.pointerMove(viewport, { pointerId: 31, ...modifiers, ...position });
}

/** The underline boxes drawn under the marked link, in pixels. */
function underlines() {
	return [
		...document.querySelectorAll<HTMLElement>(
			'[data-testid="structured-terminal-link-underline"] > div',
		),
	].map((line) => ({
		left: line.style.left,
		top: line.style.top,
		width: line.style.width,
	}));
}

function pointerIntents() {
	return sentRecords("inputIntent").filter(({ record }) =>
		record.body.case === "inputIntent"
			? record.body.value.intent.case === "pointer"
			: false,
	);
}

describe("structured terminal links", () => {
	it("opens a Cmd-clicked path:line in the file viewer of the pane's Space at that line", async () => {
		Object.assign(useStore.getState(), {
			sessionCwd: { "session-a": "/repo" },
		});
		const viewport = await bootWithText(["error: src/app.ts:12:3 bad"], {
			runtimeWorkingDirectory: "/elsewhere",
		});

		click(viewport, at(10));

		await waitFor(() => expect(links.openFileViewer).toHaveBeenCalledOnce());
		expect(links.openFileViewer).toHaveBeenCalledWith(DESKTOP, {
			path: "/repo/src/app.ts",
			source: "local",
			reveal: { line: 12, column: 3 },
		});
		expect(links.openExternalUrl).not.toHaveBeenCalled();
	});

	it("resolves against the folder the pane opened in until the session reports one", async () => {
		const viewport = await bootWithText(["see ./notes.md and ~/todo.md"], {
			runtimeWorkingDirectory: "/work",
		});

		click(viewport, at(6));
		click(viewport, at(20));

		await waitFor(() => expect(links.openFileViewer).toHaveBeenCalledTimes(2));
		expect(links.openFileViewer).toHaveBeenNthCalledWith(1, DESKTOP, {
			path: "/work/notes.md",
			source: "local",
		});
		expect(links.openFileViewer).toHaveBeenNthCalledWith(2, DESKTOP, {
			path: "/Users/me/todo.md",
			source: "local",
		});
	});

	it("opens a path printed in an SSH-backed pane on that Host", async () => {
		// The harness's remote catalog serves this standalone session on RTS.
		const viewport = await bootWithText(["  --> src/main.rs:7"], {
			sessionId: "standalone_source",
			binding: remoteHmuxStandaloneBinding(
				"standalone_source",
				"workspace_source",
				"host-rts",
				"bridge_nonce",
			),
			runtimeWorkingDirectory: "/srv/app",
		});

		click(viewport, at(8));

		await waitFor(() =>
			expect(links.openFileViewer).toHaveBeenCalledWith(DESKTOP, {
				path: "/srv/app/src/main.rs",
				source: "ssh",
				hostId: "host-rts",
				reveal: { line: 7 },
			}),
		);
	});

	it("sends a Cmd-clicked URL and a Shift+Cmd-clicked local path to the operating system", async () => {
		const viewport = await bootWithText(
			["Local: http://localhost:5173/ out/report.pdf"],
			{ runtimeWorkingDirectory: "/repo" },
		);

		click(viewport, at(12));
		click(viewport, at(35), { metaKey: true, shiftKey: true });

		await waitFor(() =>
			expect(links.openExternalPath).toHaveBeenCalledWith(
				"/repo/out/report.pdf",
			),
		);
		expect(links.openExternalUrl).toHaveBeenCalledWith(
			"http://localhost:5173/",
		);
		expect(links.openFileViewer).not.toHaveBeenCalled();
	});

	it("opens localhost printed in an SSH-backed pane in the Browser on that Host's backend", async () => {
		const dock = {} as DockviewApi;
		dockviewRegistry.set(DESKTOP, dock);
		const viewport = await bootWithText(
			["Local: http://localhost:5173/ docs https://example.com/"],
			{
				sessionId: "standalone_source",
				binding: remoteHmuxStandaloneBinding(
					"standalone_source",
					"workspace_source",
					"host-rts",
					"bridge_nonce",
				),
			},
		);

		click(viewport, at(12));
		await waitFor(() =>
			expect(links.openBrowserPanelOn).toHaveBeenCalledWith(
				dock,
				"http://localhost:5173/",
				"profile-host-rts",
			),
		);
		expect(links.resolveHostRoute).toHaveBeenCalledWith(
			"host-rts",
			useStore.getState().sshHosts,
		);

		// Shift, and an address on another machine, still go to the OS.
		click(viewport, at(12), { metaKey: true, shiftKey: true });
		click(viewport, at(40));
		await waitFor(() => expect(links.openExternalUrl).toHaveBeenCalledTimes(2));
		expect(links.openExternalUrl).toHaveBeenNthCalledWith(
			1,
			"http://localhost:5173/",
		);
		expect(links.openExternalUrl).toHaveBeenNthCalledWith(
			2,
			"https://example.com/",
		);
		expect(links.openBrowserPanelOn).toHaveBeenCalledOnce();
	});

	it("sends localhost to the OS when no backend serves the pane's Host", async () => {
		links.resolveHostRoute.mockResolvedValueOnce(undefined);
		const viewport = await bootWithText(["http://127.0.0.1:8080/"], {
			sessionId: "standalone_source",
			binding: remoteHmuxStandaloneBinding(
				"standalone_source",
				"workspace_source",
				"host-rts",
				"bridge_nonce",
			),
		});

		click(viewport, at(4));

		await waitFor(() =>
			expect(links.openExternalUrl).toHaveBeenCalledWith(
				"http://127.0.0.1:8080/",
			),
		);
		expect(links.openBrowserPanelOn).not.toHaveBeenCalled();
	});

	it("claims a link click from an app that reports the mouse, and leaves plain clicks to it", async () => {
		const viewport = await bootWithText(
			["src/app.ts:4"],
			{ runtimeWorkingDirectory: "/repo" },
			MouseTrackingMode.ANY,
		);
		mocks.send.mockClear();

		click(viewport, at(2));
		await waitFor(() => expect(links.openFileViewer).toHaveBeenCalledOnce());
		expect(pointerIntents()).toHaveLength(0);

		click(viewport, at(2), {});
		await waitFor(() => expect(pointerIntents().length).toBeGreaterThan(0));
		expect(links.openFileViewer).toHaveBeenCalledOnce();
	});

	it("underlines the link under the pointer and shows a hand only while Cmd is held", async () => {
		const viewport = await bootWithText(["error: src/app.ts:12:3 bad"], {
			runtimeWorkingDirectory: "/repo",
		});

		hover(viewport, at(10), {});
		expect(underlines()).toEqual([]);
		expect(viewport.dataset.terminalLinkHover).toBeUndefined();

		// Pressing Cmd over a still pointer marks the whole link.
		fireEvent.keyDown(window, { key: "Meta", metaKey: true });
		expect(underlines()).toEqual([
			{ left: "70px", top: "19px", width: "150px" },
		]);
		expect(viewport.dataset.terminalLinkHover).toBe("");

		fireEvent.keyUp(window, { key: "Meta", metaKey: false });
		expect(underlines()).toEqual([]);
		expect(viewport.dataset.terminalLinkHover).toBeUndefined();

		hover(viewport, at(10));
		expect(underlines()).toHaveLength(1);
		hover(viewport, at(24));
		expect(underlines()).toEqual([]);
		hover(viewport, at(10));
		fireEvent.pointerLeave(viewport, { pointerId: 31 });
		expect(underlines()).toEqual([]);
		hover(viewport, at(10));
		fireEvent.blur(window);
		expect(underlines()).toEqual([]);
	});

	it("marks only links a click would open", async () => {
		const viewport = await bootWithText(["src/app.ts:4 http://example.com/"], {
			runtimeWorkingDirectory: "/repo",
		});

		publishTerminalExecutionLocation("session-a", {
			kind: "ssh",
			target: "build-box",
		});
		hover(viewport, at(2));
		expect(underlines()).toEqual([]);
		// A URL still opens with the OS from inside the hop.
		hover(viewport, at(20));
		expect(underlines()).toEqual([
			{ left: "130px", top: "19px", width: "190px" },
		]);
		publishTerminalExecutionLocation("session-a", { kind: "local" });

		// Without a Space, a file has nowhere to open.
		dockviewRegistry.delete(DESKTOP);
		hover(viewport, at(2));
		expect(underlines()).toEqual([]);
		dockviewRegistry.set(DESKTOP, {} as DockviewApi);
		hover(viewport, at(3));
		expect(underlines()).toEqual([
			{ left: "0px", top: "19px", width: "120px" },
		]);
	});

	it("follows new output under a still pointer", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView({ runtimeWorkingDirectory: "/repo" });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({ texts: ["src/app.ts:4"] }),
		);
		const viewport = terminalViewport(view.container);
		vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(
			new DOMRect(0, 0, 800, 20),
		);

		hover(viewport, at(4));
		expect(underlines()).toEqual([
			{ left: "0px", top: "19px", width: "120px" },
		]);

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({ texts: ["plain words"], projectionRevision: 2n }),
		);
		await waitFor(() => expect(underlines()).toEqual([]));

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({ texts: ["go docs/a.md"], projectionRevision: 3n }),
		);
		await waitFor(() =>
			expect(underlines()).toEqual([
				{ left: "30px", top: "19px", width: "90px" },
			]),
		);
	});

	it("opens nothing for a drag, a plain word or a path inside a nested ssh hop", async () => {
		const viewport = await bootWithText(["src/app.ts:4 plain words"], {
			runtimeWorkingDirectory: "/repo",
		});

		click(viewport, at(2), { metaKey: true }, at(9));
		click(viewport, at(16));
		click(viewport, at(2), {});
		publishTerminalExecutionLocation("session-a", {
			kind: "ssh",
			target: "build-box",
		});
		click(viewport, at(2));
		await new Promise((resolve) => setTimeout(resolve, 0));
		publishTerminalExecutionLocation("session-a", { kind: "local" });

		expect(links.openFileViewer).not.toHaveBeenCalled();
		expect(links.openExternalUrl).not.toHaveBeenCalled();
	});
});
