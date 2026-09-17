// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { type ComponentProps, useEffect, useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeProvider } from "@/components/workspace/WorkspaceRuntimeContext";
import {
	getHmuxPaneHealth,
	publishHmuxPaneHealthObservation,
	useHmuxPaneHealthPresentation,
} from "@/lib/terminal/hmuxPaneHealthStore";
import { TerminalPresentationRoleStore } from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import {
	hmuxLocalBinding,
	hmuxManagedBinding,
	hmuxStandaloneBinding,
	remoteHmuxManagedBinding,
	remoteHmuxStandaloneBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { setAgentSessionSourceOpen } from "@/lib/workspace/window/agentSessionWindowSource";

const structuredLifecycle = vi.hoisted(() => ({
	mount: vi.fn(),
	unmount: vi.fn(),
	paintOnMount: true,
	paintedText: undefined as string | undefined,
}));
const windowLifecycle = vi.hoisted(() => ({
	openAgentSessionWindow: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));

vi.mock("@/lib/workspace/window/windows", () => ({
	openAgentSessionWindow: windowLifecycle.openAgentSessionWindow,
}));

vi.mock("@/components/terminal/structured/StructuredTerminalView", () => ({
	StructuredTerminalView: ({
		surfaceId,
		paneHealthId,
		binding,
		presentationRole,
		onFirstPaint,
	}: {
		surfaceId: string;
		paneHealthId?: string;
		binding: { sessionId: string };
		presentationRole?: string;
		onFirstPaint?: () => void;
	}) => {
		useLayoutEffect(() => {
			if (structuredLifecycle.paintOnMount) onFirstPaint?.();
		}, [onFirstPaint]);
		useEffect(() => {
			structuredLifecycle.mount(binding.sessionId);
			return structuredLifecycle.unmount;
		}, [binding.sessionId]);
		return (
			<div
				data-testid="structured-terminal"
				data-surface-id={surfaceId}
				data-pane-health-id={paneHealthId}
				data-session-id={binding.sessionId}
				data-presentation-role={presentationRole}
			>
				<div
					data-testid="structured-terminal-presentation"
					data-terminal-surface-id={surfaceId}
				>
					{structuredLifecycle.paintOnMount
						? (structuredLifecycle.paintedText ?? binding.sessionId)
						: null}
				</div>
			</div>
		);
	},
}));

import { TerminalView } from "@/components/terminal/TerminalView";

const legacyLocalBinding = (sessionId: string) =>
	({
		schemaVersion: 1,
		runtime: "legacy_session_v1",
		source: "local",
		hostId: "local",
		sessionId,
	}) as unknown as TerminalPaneBindingV1;
const legacySshBinding = (sessionId: string, hostId: string) =>
	({
		schemaVersion: 1,
		runtime: "legacy_ssh_session_v1",
		source: "ssh",
		hostId,
		sessionId,
	}) as unknown as TerminalPaneBindingV1;

const foregroundPresentationRoleStore = {
	subscribeRole: () => () => {},
	role: () => "foreground" as const,
	setHovered: () => {},
} as never;

function setDocumentVisibility(state: DocumentVisibilityState) {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: state,
	});
}

function PaneHealthText({ paneId }: { paneId: string }) {
	const health = useHmuxPaneHealthPresentation(paneId);
	return (
		<output data-testid="pane-health">{health?.state ?? "unobserved"}</output>
	);
}

afterEach(() => {
	cleanup();
	structuredLifecycle.paintOnMount = true;
	structuredLifecycle.paintedText = undefined;
	setDocumentVisibility("visible");
});

describe("TerminalView presentation route", () => {
	it("routes every Hmux binding to the structured surface and legacy bindings to the retirement notice", async () => {
		const hmuxBindings = [
			hmuxLocalBinding("observer-session", "workspace-a"),
			hmuxStandaloneBinding("standalone-session", "workspace-a"),
			hmuxManagedBinding("managed-session", "workspace-a"),
			remoteHmuxStandaloneBinding(
				"remote-standalone-session",
				"workspace-a",
				"ssh-host-a",
				"bridge-a",
			),
			remoteHmuxManagedBinding(
				"remote-managed-session",
				"workspace-a",
				"ssh-host-a",
				"bridge-b",
			),
		];

		const rendered = render(
			hmuxBindings.map((binding, index) => (
				<TerminalView
					key={binding.sessionId}
					sessionId={binding.sessionId}
					kind={binding.source === "local" ? "pty" : "ssh"}
					binding={binding}
					paneApi={
						{
							id: `pane-${index}`,
							isVisible: true,
							onDidVisibilityChange: () => ({ dispose() {} }),
						} as unknown as ComponentProps<typeof TerminalView>["paneApi"]
					}
				/>
			)),
		);

		expect(
			screen
				.getAllByTestId("structured-terminal")
				.map((terminal) => terminal.dataset.surfaceId),
		).toEqual(hmuxBindings.map((_, index) => `pane-${index}`));
		expect(screen.queryByTestId("retired-legacy-terminal")).toBeNull();

		const legacyBindings = [
			legacyLocalBinding("local-session"),
			legacySshBinding("ssh-session", "ssh-host-a"),
		];
		rendered.rerender(
			legacyBindings.map((binding) => (
				<TerminalView
					key={binding.sessionId}
					sessionId={binding.sessionId}
					kind={binding.source === "local" ? "pty" : "ssh"}
					binding={binding}
				/>
			)),
		);

		// The legacy runtime is retired: persisted legacy panes render a
		// dead-end notice and never reach a terminal surface.
		expect(screen.getAllByTestId("retired-legacy-terminal")).toHaveLength(2);
		expect(screen.queryByTestId("structured-terminal")).toBeNull();
	});

	it("owns a structured surface while its pane is visible and its desktop is warm or active", () => {
		let paneVisible = true;
		let notifyVisibility = () => {};
		const paneApi = {
			id: "pane-visible",
			get isVisible() {
				return paneVisible;
			},
			onDidVisibilityChange: (listener: () => void) => {
				notifyVisibility = listener;
				return { dispose() {} };
			},
		} as unknown as ComponentProps<typeof TerminalView>["paneApi"];
		const binding = hmuxStandaloneBinding("session-visible", "workspace-a");
		const route = (active: boolean, frozen = false) => (
			<WorkspaceRuntimeProvider
				desktopId="desktop-a"
				active={active}
				frozen={frozen}
				presentationRoleStore={foregroundPresentationRoleStore}
				commitLayout={() => true}
			>
				<TerminalView
					sessionId={binding.sessionId}
					kind="pty"
					binding={binding}
					paneApi={paneApi}
				/>
			</WorkspaceRuntimeProvider>
		);

		structuredLifecycle.mount.mockClear();
		structuredLifecycle.unmount.mockClear();
		const rendered = render(route(true));
		const paneHealthId = "desktop-a:pane-visible";
		expect(structuredLifecycle.mount).toHaveBeenCalledOnce();
		expect(screen.getByTestId("structured-terminal").dataset.surfaceId).toBe(
			"window:main:desktop:desktop-a:pane:pane-visible",
		);
		expect(screen.getByTestId("structured-terminal").dataset.paneHealthId).toBe(
			paneHealthId,
		);
		expect(
			screen.getByTestId("structured-terminal").dataset.presentationRole,
		).toBe("foreground");
		publishHmuxPaneHealthObservation(paneHealthId, {
			kind: "frame_presented",
			terminalEpoch: "terminal-a",
			sequence: "7",
		});

		act(() => {
			paneVisible = false;
			notifyVisibility();
		});
		expect(screen.queryByTestId("structured-terminal")).toBeNull();
		expect(structuredLifecycle.unmount).toHaveBeenCalledOnce();
		expect(getHmuxPaneHealth(paneHealthId)?.state).toBe("live");

		act(() => {
			paneVisible = true;
			notifyVisibility();
		});
		expect(screen.getByTestId("structured-terminal")).toBeTruthy();
		expect(structuredLifecycle.mount).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId("structured-terminal").dataset.sessionId).toBe(
			binding.sessionId,
		);
		expect(structuredLifecycle.mount).toHaveBeenLastCalledWith(
			binding.sessionId,
		);

		// A warm (mounted, not frozen) desktop keeps the surface attached while
		// hidden, so switching back reveals painted rows without a new attach.
		rendered.rerender(route(false));
		expect(screen.getByTestId("structured-terminal").dataset.sessionId).toBe(
			binding.sessionId,
		);
		expect(structuredLifecycle.unmount).toHaveBeenCalledOnce();
		rendered.rerender(route(true));
		expect(structuredLifecycle.mount).toHaveBeenCalledTimes(2);

		// The frozen tier releases the surface; activation re-attaches it.
		rendered.rerender(route(false, true));
		expect(screen.queryByTestId("structured-terminal")).toBeNull();
		expect(structuredLifecycle.unmount).toHaveBeenCalledTimes(2);
		rendered.rerender(route(true, true));
		expect(screen.getByTestId("structured-terminal").dataset.sessionId).toBe(
			binding.sessionId,
		);
		expect(structuredLifecycle.mount).toHaveBeenCalledTimes(3);
		expect(structuredLifecycle.mount).toHaveBeenLastCalledWith(
			binding.sessionId,
		);

		rendered.unmount();
		expect(getHmuxPaneHealth(paneHealthId)).toBeUndefined();
	});

	it("promotes a hovered background pane without changing pane focus", () => {
		const roleStore = new TerminalPresentationRoleStore();
		roleStore.configure({ active: true, foregroundPanelId: "pane-focused" });
		const binding = hmuxStandaloneBinding("session-hovered", "workspace-a");
		const paneApi = {
			id: "pane-hovered",
			isVisible: true,
			onDidVisibilityChange: () => ({ dispose() {} }),
		} as unknown as ComponentProps<typeof TerminalView>["paneApi"];

		render(
			<WorkspaceRuntimeProvider
				desktopId="desktop-a"
				active
				presentationRoleStore={roleStore}
				commitLayout={() => true}
			>
				<TerminalView
					sessionId={binding.sessionId}
					kind="pty"
					binding={binding}
					paneApi={paneApi}
				/>
			</WorkspaceRuntimeProvider>,
		);

		const terminal = screen.getByTestId("structured-terminal");
		const presenceHost = terminal.parentElement?.parentElement;
		if (!presenceHost)
			throw new Error("terminal presence host was not mounted");
		expect(terminal.dataset.presentationRole).toBe("background");

		fireEvent.pointerEnter(presenceHost);
		expect(terminal.dataset.presentationRole).toBe("hovered");

		fireEvent.pointerLeave(presenceHost);
		expect(terminal.dataset.presentationRole).toBe("background");
	});

	it("retains painted pixels while releasing a hidden-document surface", () => {
		setDocumentVisibility("visible");
		const binding = hmuxStandaloneBinding("session-document", "workspace-a");
		structuredLifecycle.mount.mockClear();
		structuredLifecycle.unmount.mockClear();
		render(
			<WorkspaceRuntimeProvider
				desktopId="desktop-a"
				active={true}
				presentationRoleStore={foregroundPresentationRoleStore}
				commitLayout={() => true}
			>
				<TerminalView
					sessionId={binding.sessionId}
					kind="pty"
					binding={binding}
					paneApi={
						{
							id: "pane-document",
							isVisible: true,
							onDidVisibilityChange: () => ({ dispose() {} }),
						} as unknown as ComponentProps<typeof TerminalView>["paneApi"]
					}
				/>
			</WorkspaceRuntimeProvider>,
		);

		expect(structuredLifecycle.mount).toHaveBeenCalledOnce();
		expect(
			screen.getByTestId("terminal-presentation-snapshot").childElementCount,
		).toBe(0);
		act(() => {
			setDocumentVisibility("hidden");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(screen.queryByTestId("structured-terminal")).toBeNull();
		expect(structuredLifecycle.unmount).toHaveBeenCalledOnce();
		const snapshot = screen.getByTestId("terminal-presentation-snapshot");
		expect(snapshot.textContent).toBe(binding.sessionId);
		expect(snapshot.querySelector("[data-terminal-surface-id]")).toBeNull();

		act(() => {
			setDocumentVisibility("visible");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(screen.getByTestId("structured-terminal").dataset.sessionId).toBe(
			binding.sessionId,
		);
		expect(
			screen.getByTestId("terminal-presentation-snapshot").childElementCount,
		).toBe(0);
		expect(structuredLifecycle.mount).toHaveBeenCalledTimes(2);
	});

	it("keeps a hidden warm desktop's surface attached across a hidden document", () => {
		setDocumentVisibility("visible");
		const binding = hmuxStandaloneBinding("session-warm-hidden", "workspace-a");
		structuredLifecycle.mount.mockClear();
		structuredLifecycle.unmount.mockClear();
		render(
			<WorkspaceRuntimeProvider
				desktopId="desktop-b"
				active={false}
				presentationRoleStore={foregroundPresentationRoleStore}
				commitLayout={() => true}
			>
				<TerminalView
					sessionId={binding.sessionId}
					kind="pty"
					binding={binding}
					paneApi={
						{
							id: "pane-warm-hidden",
							isVisible: true,
							onDidVisibilityChange: () => ({ dispose() {} }),
						} as unknown as ComponentProps<typeof TerminalView>["paneApi"]
					}
				/>
			</WorkspaceRuntimeProvider>,
		);
		expect(structuredLifecycle.mount).toHaveBeenCalledOnce();

		act(() => {
			setDocumentVisibility("hidden");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(screen.getByTestId("structured-terminal")).toBeTruthy();
		expect(structuredLifecycle.unmount).not.toHaveBeenCalled();
		expect(
			screen.getByTestId("terminal-presentation-snapshot").childElementCount,
		).toBe(0);

		act(() => {
			setDocumentVisibility("visible");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(structuredLifecycle.mount).toHaveBeenCalledOnce();
	});

	it("keeps the committed snapshot when a replacement is hidden before first paint", () => {
		setDocumentVisibility("visible");
		const binding = hmuxStandaloneBinding("session-rapid", "workspace-a");
		render(
			<WorkspaceRuntimeProvider
				desktopId="desktop-a"
				active={true}
				presentationRoleStore={foregroundPresentationRoleStore}
				commitLayout={() => true}
			>
				<TerminalView
					sessionId={binding.sessionId}
					kind="pty"
					binding={binding}
					paneApi={
						{
							id: "pane-rapid",
							isVisible: true,
							onDidVisibilityChange: () => ({ dispose() {} }),
						} as unknown as ComponentProps<typeof TerminalView>["paneApi"]
					}
				/>
			</WorkspaceRuntimeProvider>,
		);

		act(() => {
			setDocumentVisibility("hidden");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		const snapshot = screen.getByTestId("terminal-presentation-snapshot");
		expect(snapshot.textContent).toBe(binding.sessionId);

		structuredLifecycle.paintOnMount = false;
		act(() => {
			setDocumentVisibility("visible");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(screen.getByTestId("structured-terminal")).toBeTruthy();
		expect(snapshot.textContent).toBe(binding.sessionId);

		act(() => {
			setDocumentVisibility("hidden");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(screen.queryByTestId("structured-terminal")).toBeNull();
		expect(snapshot.textContent).toBe(binding.sessionId);

		structuredLifecycle.paintOnMount = true;
		structuredLifecycle.paintedText = "replacement-frame";
		act(() => {
			setDocumentVisibility("visible");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(snapshot.childElementCount).toBe(0);
		act(() => {
			setDocumentVisibility("hidden");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(snapshot.textContent).toBe("replacement-frame");
	});

	it("renders the retirement notice for a persisted legacy pane without any terminal lifecycle", async () => {
		const binding = legacyLocalBinding("legacy-session-visible");
		structuredLifecycle.mount.mockClear();
		render(
			<WorkspaceRuntimeProvider
				desktopId="desktop-a"
				active={true}
				presentationRoleStore={foregroundPresentationRoleStore}
				commitLayout={() => true}
			>
				<TerminalView
					sessionId={binding.sessionId}
					kind="pty"
					binding={binding}
					paneApi={
						{
							id: "legacy-pane-visible",
							isVisible: true,
							onDidVisibilityChange: () => ({ dispose() {} }),
						} as unknown as ComponentProps<typeof TerminalView>["paneApi"]
					}
				/>
			</WorkspaceRuntimeProvider>,
		);
		await vi.dynamicImportSettled();

		expect(screen.getByTestId("retired-legacy-terminal")).toBeTruthy();
		expect(screen.queryByTestId("structured-terminal")).toBeNull();
		expect(structuredLifecycle.mount).not.toHaveBeenCalled();
	});

	it("keeps a detached large-view structured surface mounted", () => {
		const binding = hmuxStandaloneBinding("large-view", "workspace-a");
		render(
			<TerminalView
				sessionId={binding.sessionId}
				kind="pty"
				binding={binding}
			/>,
		);

		expect(screen.getByTestId("structured-terminal")).toBeTruthy();
	});

	it("releases the source pane renderer while its large view is active", () => {
		localStorage.setItem(
			"dure:agent-session-source:agent-1",
			JSON.stringify({
				windowLabel: "main",
				paneOwnerId: "desktop-a:pane-a",
				open: true,
			}),
		);
		const binding = hmuxManagedBinding("managed-session", "workspace-a");
		const props = {
			sessionId: binding.sessionId,
			kind: "pty",
			binding,
			largeView: { agentId: "agent-1", sourceWindowLabel: "main" },
			paneApi: {
				id: "pane-a",
				isVisible: true,
				onDidVisibilityChange: () => ({ dispose() {} }),
			},
		} as unknown as ComponentProps<typeof TerminalView>;

		render(
			<WorkspaceRuntimeProvider
				desktopId="desktop-a"
				active
				presentationRoleStore={foregroundPresentationRoleStore}
				commitLayout={() => true}
			>
				<TerminalView {...props} />
			</WorkspaceRuntimeProvider>,
		);

		expect(screen.queryByTestId("structured-terminal")).toBeNull();
		expect(
			screen.getByRole("button", { name: "큰 창 앞으로 가져오기" }),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "큰 창 앞으로 가져오기" }),
		);
		expect(windowLifecycle.openAgentSessionWindow).toHaveBeenCalledWith(
			"agent-1",
			undefined,
			"desktop-a:pane-a",
		);
	});

	it.each(["large-view transfer", "binding replacement while detached"])(
		"retires the old pane recovery observation on %s",
		(transition) => {
			const source = {
				windowLabel: "main",
				paneOwnerId: "desktop-a:pane-health",
			};
			const agentId = "agent-health-transfer";
			const binding = hmuxManagedBinding("source-session", "workspace-a");
			let publishFirstPaint = false;
			const paneApi = {
				id: "pane-health",
				isVisible: true,
				onDidVisibilityChange: () => ({ dispose() {} }),
			} as unknown as ComponentProps<typeof TerminalView>["paneApi"];
			setAgentSessionSourceOpen(
				agentId,
				source,
				transition === "binding replacement while detached",
			);
			const route = (currentBinding: TerminalPaneBindingV1) => (
				<WorkspaceRuntimeProvider
					desktopId="desktop-a"
					active
					presentationRoleStore={foregroundPresentationRoleStore}
					commitLayout={() => true}
				>
					<PaneHealthText paneId={source.paneOwnerId} />
					<TerminalView
						sessionId={currentBinding.sessionId}
						kind="pty"
						binding={currentBinding}
						paneApi={paneApi}
						largeView={{ agentId, sourceWindowLabel: source.windowLabel }}
						onFirstPaint={() => {
							if (!publishFirstPaint) return;
							publishHmuxPaneHealthObservation(source.paneOwnerId, {
								kind: "frame_presented",
								terminalEpoch: currentBinding.sessionId,
								sequence: "1",
							});
						}}
					/>
				</WorkspaceRuntimeProvider>
			);
			const rendered = render(route(binding));
			act(() => {
				publishHmuxPaneHealthObservation(source.paneOwnerId, {
					kind: "connection",
					state: "recovering",
					reason: "automatic_reboot_recovery",
				});
			});
			expect(screen.getByTestId("pane-health").textContent).toBe("recovering");
			// Equivalent projection objects must not retire an observation.
			rendered.rerender(route({ ...binding }));
			expect(screen.getByTestId("pane-health").textContent).toBe("recovering");
			if (transition === "large-view transfer") {
				act(() => setAgentSessionSourceOpen(agentId, source, true));
			} else {
				rendered.rerender(
					route(hmuxManagedBinding("replacement-session", "workspace-a")),
				);
			}
			expect(screen.queryByTestId("structured-terminal")).toBeNull();
			expect(screen.getByTestId("pane-health").textContent).toBe("unobserved");
			expect(getHmuxPaneHealth(source.paneOwnerId)).toBeUndefined();
			publishFirstPaint = true;
			act(() => setAgentSessionSourceOpen(agentId, source, false));
			expect(screen.getByTestId("structured-terminal")).toBeTruthy();
			expect(screen.getByTestId("pane-health").textContent).toBe("live");
			// Cleanup must precede a visible successor's first layout-phase paint.
			rendered.rerender(
				route(hmuxManagedBinding("visible-successor", "workspace-a")),
			);
			expect(getHmuxPaneHealth(source.paneOwnerId)).toMatchObject({
				state: "live",
				terminalEpoch: "visible-successor",
				presentedSequence: "1",
			});
		},
	);

	it("starts without a presentation leaked by the previous route contract", () => {
		expect(
			screen.queryByRole("button", { name: "큰 창 앞으로 가져오기" }),
		).toBeNull();
	});
});
