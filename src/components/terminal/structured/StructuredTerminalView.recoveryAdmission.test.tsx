// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { getHmuxPaneHealth } from "@/lib/terminal/hmuxPaneHealthStore";
import { TERMINAL_CONNECTION_FAILURE_MESSAGE_ID } from "@/lib/terminal/state/terminalFailurePresentation";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import {
	hmuxPaneBinding as binding,
	closedRecord,
	viewportFrameRecord,
} from "@/test/terminalRecordFixtures";
import { StructuredTerminalView } from "./StructuredTerminalView";
import {
	attachReceipt,
	bootTerminalWithFrame,
	deliverRecord,
	deliverViewportFrame,
	installAttachMock,
	mocks,
	pressEnter,
	registerStructuredTerminalView,
	renderTerminalView,
	resetStructuredTerminalHarness,
	restoreStructuredTerminalHarness,
	sentInputIntents,
	terminalInput,
} from "./structuredTerminalTestHarness";

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
vi.mock("@/lib/ipc", async () =>
	(await import("./structuredTerminalTestHarness")).ipcMockFactory(),
);
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
beforeEach(resetStructuredTerminalHarness);
afterEach(restoreStructuredTerminalHarness);

describe("workspace recovery admission", () => {
	it("focus, role changes and typed input keep the existing attachment", async () => {
		const before = workspacePerformance.snapshot().terminalRecovery?.counts;
		const { view } = await bootTerminalWithFrame({ texts: ["ready"] });
		for (const role of ["background", "hovered", "foreground"] as const) {
			view.rerender(
				<StructuredTerminalView
					sessionId="session-a"
					surfaceId="pane-a"
					binding={binding("session-a")}
					presentationRole={role}
				/>,
			);
			await act(() => terminalInput(view).focus());
		}
		fireEvent.input(terminalInput(view), { target: { value: "x" } });
		pressEnter(terminalInput(view));
		await waitFor(() => expect(sentInputIntents("text")).toHaveLength(1));
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(workspacePerformance.snapshot().terminalRecovery?.counts).toEqual(
			before,
		);
	});

	it.each(["hmux_session_exited", "hmux_incompatible_protocol"] as const)(
		"preserves a queued %s terminal refusal without retrying",
		async (code) => {
			const before = workspacePerformance.snapshot().terminalRecovery?.counts;
			if (!before) throw new Error("Recovery diagnostics missing");
			const releases: Array<() => void> = [];
			const occupied = Array.from({ length: 4 }, () =>
				mocks.recoveryAdmission.run({
					signal: new AbortController().signal,
					readRole: () => "background",
					operation: () =>
						new Promise<void>((resolve) => {
							releases.push(resolve);
						}),
				}),
			);
			const refusal = Object.assign(new Error(code), {
				code,
				retryDirective: "never" as const,
			});
			const onRecords = installAttachMock((attempt) =>
				attempt === 1 ? undefined : Promise.reject(refusal),
			);
			const onHmuxSessionExit = vi.fn();
			const paneHealthId = `desktop-a:agent:${code}`;
			const view = renderTerminalView({ onHmuxSessionExit, paneHealthId });
			try {
				await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
				await deliverViewportFrame(onRecords[0]);
				await deliverRecord(
					onRecords[0],
					closedRecord(
						"hmux_transport_closed",
						"fixture disconnect",
						"reconnect",
					),
				);
				await waitFor(() =>
					expect(
						workspacePerformance.snapshot().terminalRecovery?.counts.queued,
					).toBe(before.queued + 1),
				);
				expect(mocks.attach).toHaveBeenCalledOnce();
				releases[0]?.();
				if (code === "hmux_session_exited") {
					await waitFor(() =>
						expect(onHmuxSessionExit).toHaveBeenCalledWith({ reason: code }),
					);
				} else {
					await view.findByText(t(TERMINAL_CONNECTION_FAILURE_MESSAGE_ID));
					expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
						state: "error",
						reason: code,
					});
					expect(onHmuxSessionExit).not.toHaveBeenCalled();
				}
				await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
				expect(mocks.attach).toHaveBeenCalledTimes(2);
				expect(
					workspacePerformance.snapshot().terminalRecovery?.counts,
				).toEqual({
					...before,
					queued: before.queued + 1,
					admitted: before.admitted + 1,
					backendAttachRequests: before.backendAttachRequests + 1,
				});
			} finally {
				view.unmount();
				for (const release of releases) release();
				await Promise.all(occupied);
			}
		},
	);

	it("stops a persistently retryable attach after one bounded episode", async () => {
		const before = workspacePerformance.snapshot().terminalRecovery?.counts;
		if (!before) throw new Error("Recovery diagnostics missing");
		const retryableRefusal = () =>
			Object.assign(new Error("persistent viewport attach refusal"), {
				code: "hmux_transport_closed",
				retryDirective: "reconnect" as const,
			});
		const paneHealthId = "desktop-a:agent:bounded-attach";
		installAttachMock(() => Promise.reject(retryableRefusal()));
		vi.useFakeTimers();
		const view = renderTerminalView({ paneHealthId });
		try {
			await act(async () => {
				await Promise.resolve();
			});
			for (let retry = 0; retry < 10; retry += 1) {
				await act(async () => {
					await vi.runOnlyPendingTimersAsync();
					await Promise.resolve();
				});
			}

			expect(mocks.attach).toHaveBeenCalledTimes(11);
			expect(workspacePerformance.snapshot().terminalRecovery?.counts).toEqual({
				...before,
				admitted: before.admitted + 10,
				backendAttachRequests: before.backendAttachRequests + 10,
				exhausted: before.exhausted + 1,
			});
			expect(
				view.getByText(t(TERMINAL_CONNECTION_FAILURE_MESSAGE_ID)),
			).toBeTruthy();
			expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
				state: "error",
				reason: "persistent viewport attach refusal",
			});
			await act(async () => {
				await vi.runOnlyPendingTimersAsync();
			});
			expect(mocks.attach).toHaveBeenCalledTimes(11);
		} finally {
			view.unmount();
			vi.useRealTimers();
		}
	});

	it("bounds simultaneous recovery attaches across one workspace", async () => {
		const before = workspacePerformance.snapshot().terminalRecovery?.counts;
		if (!before) throw new Error("Recovery diagnostics missing");
		const sessions = Array.from(
			{ length: 6 },
			(_, index) => `recovery-session-${index + 1}`,
		);
		const foregroundSession = sessions[sessions.length - 1] as string;
		const canceledSession = sessions[sessions.length - 2] as string;
		const pendingInitial = new Set<() => void>();
		const pendingRecovery = new Set<() => void>();
		const releasesBySession = new Map<string, () => void>();
		const recoveryStarts: string[] = [];
		const retirements: Promise<void>[] = [];
		let activeRecovery = 0;
		let peakRecovery = 0;
		const onRecords = installAttachMock((attach, request) => {
			if (attach <= sessions.length) {
				return new Promise((resolve) => {
					const release = () => {
						if (!pendingInitial.delete(release)) return;
						resolve(attachReceipt());
					};
					pendingInitial.add(release);
				});
			}
			const sessionId = request.sessionId as string;
			activeRecovery += 1;
			peakRecovery = Math.max(peakRecovery, activeRecovery);
			recoveryStarts.push(sessionId);
			return new Promise((resolve) => {
				const release = () => {
					if (!pendingRecovery.delete(release)) return;
					releasesBySession.delete(sessionId);
					activeRecovery -= 1;
					request.onRecord(viewportFrameRecord().buffer as ArrayBuffer);
					resolve(attachReceipt());
				};
				pendingRecovery.add(release);
				releasesBySession.set(sessionId, release);
			});
		});
		const terminalViews = (visibleSessions: readonly string[]) =>
			visibleSessions.map((sessionId) => (
				<StructuredTerminalView
					key={sessionId}
					sessionId={sessionId}
					surfaceId={`recovery-surface-${sessionId}`}
					binding={binding(sessionId)}
					presentationRole={
						sessionId === foregroundSession ? "foreground" : "background"
					}
					onStructuredSurfaceRetirement={(retirement) =>
						retirements.push(retirement)
					}
				/>
			));
		const view = render(terminalViews(sessions));

		const drainInitial = async () => {
			for (let pass = 0; pass < sessions.length + 1; pass += 1) {
				const releases = [...pendingInitial];
				await act(async () => {
					for (const release of releases) release();
					await Promise.resolve();
				});
			}
		};
		const drainRecovery = async () => {
			for (let pass = 0; pass < sessions.length + 1; pass += 1) {
				const releases = [...pendingRecovery];
				await act(async () => {
					for (const release of releases) release();
					await Promise.resolve();
				});
			}
		};

		try {
			await waitFor(() =>
				expect(mocks.attach).toHaveBeenCalledTimes(sessions.length),
			);
			expect(pendingInitial.size).toBe(sessions.length);
			await drainInitial();
			for (const onRecord of onRecords.slice(0, sessions.length)) {
				await deliverViewportFrame(onRecord);
			}

			const close = closedRecord(
				"hmux_transport_closed",
				"shared carrier interruption",
				"reconnect",
			);
			await act(async () => {
				for (const onRecord of onRecords.slice(0, sessions.length)) {
					onRecord(close.buffer as ArrayBuffer);
				}
			});

			await waitFor(() =>
				expect(recoveryStarts.length).toBeGreaterThanOrEqual(4),
			);
			expect(peakRecovery).toBeLessThanOrEqual(4);
			expect(recoveryStarts).toEqual(sessions.slice(0, 4));

			view.rerender(
				terminalViews(
					sessions.filter((sessionId) => sessionId !== canceledSession),
				),
			);

			await act(async () => {
				releasesBySession.get(recoveryStarts[0] as string)?.();
			});
			await waitFor(() => expect(recoveryStarts).toHaveLength(5));
			expect(recoveryStarts[4]).toBe(foregroundSession);

			await drainRecovery();
			await waitFor(() =>
				expect(mocks.attach).toHaveBeenCalledTimes(sessions.length * 2 - 1),
			);
			expect(recoveryStarts).not.toContain(canceledSession);
			const recoveryObserverIds = mocks.attach.mock.calls
				.slice(sessions.length)
				.map(([request]) => request.observerId);
			expect(new Set(recoveryObserverIds).size).toBe(sessions.length - 1);
			expect(workspacePerformance.snapshot()).toMatchObject({
				terminalRecovery: {
					counts: {
						queued: before.queued + 2,
						admitted: before.admitted + 5,
						cancelled: before.cancelled + 1,
						backendAttachRequests: before.backendAttachRequests + 5,
						exhausted: before.exhausted,
					},
				},
			});
		} finally {
			await drainInitial();
			await drainRecovery();
			view.unmount();
			await Promise.allSettled(retirements);
		}
	});
});
