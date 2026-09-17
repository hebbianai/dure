// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HmuxSessionSummary, hmux } from "@/lib/ipc";
import {
	clearHmuxPaneHealth,
	publishHmuxPaneHealthObservation,
} from "@/lib/terminal/hmuxPaneHealthStore";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import { hmuxPaneHealthId } from "@/lib/terminal/terminalHealth";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import {
	preparePaneAction,
	registerPaneActions,
} from "@/lib/workspace/pane/paneActionRegistry";
import { durableAppStorage, useStore } from "@/store";
import {
	createPaneAppRestartFixture,
	preparePaneAppRestartClaims,
	snapshotPaneAppRestartFixture,
	waitForPaneAppRestartAttachments,
} from "./paneAppRestart";

const rollout = vi.hoisted(() => ({ managed: false }));
vi.mock("@/lib/hmux/standalone/hmuxStandaloneRollout", async (original) => ({
	...(await original<object>()),
	hmuxManagedShellReady: async () => rollout.managed,
	hmuxStandaloneReady: async () => true,
}));

const disposers: (() => void)[] = [];
const initialState = useStore.getState();
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
	useStore.setState(initialState, true);
});

function session(
	sessionId: string,
	workspaceId: string,
	sessionClass: "standalone" | "managed",
): HmuxSessionSummary {
	return {
		sessionId,
		workspaceId,
		sessionClass,
		lifecycle: "ready",
		manifestLifecycle: "ready",
		health: "current_healthy",
		inputAllowed: true,
		terminalEpoch: `epoch-${sessionId}`,
		outputSeq: "0",
		capabilities: ["ansi_redraw_v1"],
		...(sessionClass === "managed"
			? {
					stopFence: {
						runnerPrincipal: "fixture",
						runnerInstance: "fixture-runner",
						channelEpoch: "1",
						hostInstanceId: `host-${sessionId}`,
						terminalEpoch: `epoch-${sessionId}`,
					},
				}
			: {}),
	};
}

describe("native pane restart fixture preparation", () => {
	it.each(["pane-frame-proof", "launcher:legacy-frame-proof"])(
		"waits for the terminal's presented frame rather than display status in %s",
		async (paneId) => {
			vi.useFakeTimers();
			const spaceId = "frame-proof-space";
			const healthId = hmuxPaneHealthId(spaceId, paneId);
			disposers.push(() => clearHmuxPaneHealth(healthId));
			disposers.push(
				registerPaneActions({
					owner: {},
					paneId,
					status: "attached",
					actions: {},
				}),
			);
			const settled = vi.fn();
			const waiting = waitForPaneAppRestartAttachments(
				spaceId,
				[paneId],
				"Frame not observed",
			).then(settled);
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).not.toHaveBeenCalled();
			publishHmuxPaneHealthObservation(healthId, {
				kind: "frame_received",
				terminalEpoch: "exact-epoch",
				sequence: "0",
			});
			await vi.advanceTimersByTimeAsync(50);
			expect(settled).not.toHaveBeenCalled();
			publishHmuxPaneHealthObservation(healthId, {
				kind: "frame_presented",
				terminalEpoch: "exact-epoch",
				sequence: "0",
			});
			await vi.advanceTimersByTimeAsync(50);
			await waiting;
			expect(settled).toHaveBeenCalledOnce();
		},
	);

	it("preserves unknown and failed attachment observations at the original deadline", async () => {
		vi.useFakeTimers();
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		const element = document.createElement("div");
		document.body.append(element);
		const api = createDockview(element, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
			}),
		});
		const spaceId = "restart-observation-space";
		registerDockview(spaceId, api);
		disposers.push(() => {
			unregisterDockview(spaceId, api);
			api.dispose();
			element.remove();
		});
		api.layout(1000, 700);
		const paneIds = ["pane-attached", "launcher:failed", "pane-unknown"];
		for (const paneId of paneIds) {
			api.addPanel({
				id: paneId,
				component: "terminal",
				position: { direction: "right" },
			});
		}
		disposers.push(
			registerPaneActions({
				owner: {},
				paneId: paneIds[0],
				status: "attached",
				actions: {},
			}),
		);
		disposers.push(
			registerPaneActions({
				owner: {},
				paneId: paneIds[1],
				status: "attach_failed",
				actions: {},
				error: "exact attachment failed",
				context: "not part of the failure receipt",
			}),
		);
		const result = waitForPaneAppRestartAttachments(
			spaceId,
			paneIds,
			"Attachment deadline",
		).then(
			() => undefined,
			(error: Error) => error,
		);
		await vi.advanceTimersByTimeAsync(20_000);
		const failure = await result;
		expect(failure).toBeInstanceOf(Error);
		expect(failure?.message.split("\n")[0]).toBe("Attachment deadline");
		expect(JSON.parse(failure!.message.split("\n")[1])).toEqual({
			documentVisibility: "hidden",
			activeSpaceId: useStore.getState().activeSpaceId,
			spaceId,
			panes: paneIds.map((paneId, index) => ({
				paneId,
				component: "terminal",
				visible: true,
				status: ["attached", "attach_failed", null][index],
				error: index === 1 ? "exact attachment failed" : null,
				health: null,
			})),
		});
		expect(failure?.message).not.toContain("not part of the failure receipt");
	});

	it.each([false, true])(
		"prepares real Dockview panes through the ordinary shell route (managed=%s)",
		async (managed) => {
			rollout.managed = managed;
			const container = document.createElement("div");
			document.body.append(container);
			let mountedSpaceId = "";
			const api = createDockview(container, {
				createComponent: ({ name }) => {
					let unregister: (() => void) | undefined;
					return {
						element: document.createElement("div"),
						init({ api: panel, params }) {
							if (name === "terminal") {
								unregister = registerPaneActions({
									owner: {},
									paneId: panel.id,
									status: "attached",
									actions: { "terminal.input": async () => {} },
								});
								publishHmuxPaneHealthObservation(
									hmuxPaneHealthId(mountedSpaceId, panel.id),
									{
										kind: "frame_presented",
										terminalEpoch: `epoch-${params.binding.sessionId}`,
										sequence: "0",
									},
								);
								disposers.push(() =>
									clearHmuxPaneHealth(
										hmuxPaneHealthId(mountedSpaceId, panel.id),
									),
								);
							}
						},
						dispose() {
							unregister?.();
						},
					};
				},
			});
			api.layout(1200, 800);
			disposers.push(() => {
				api.dispose();
				container.remove();
			});
			const addSpace = useStore.getState().addSpace;
			useStore.setState({
				addSpace: (options) => {
					const spaceId = addSpace(options);
					mountedSpaceId = spaceId;
					registerDockview(spaceId, api);
					disposers.push(() => unregisterDockview(spaceId, api));
					return spaceId;
				},
			});
			const sessions: HmuxSessionSummary[] = [];
			vi.spyOn(hmux, "createStandalone").mockImplementation(async () => {
				const created = session(
					`standalone-${sessions.length}`,
					"fixture",
					"standalone",
				);
				sessions.push(created);
				return created;
			});
			vi.spyOn(hmux, "createManagedShell").mockImplementation(
				async (request) => {
					const created = session(
						request.sessionId,
						request.workspaceId,
						"managed",
					);
					sessions.push(created);
					return {
						idempotencyKey: request.idempotencyKey,
						outcome: "created",
						session: created,
					};
				},
			);
			vi.spyOn(hmux, "inspectSessionsExact").mockImplementation(
				async (targets) =>
					targets.map((target) => ({
						...target,
						outcome: "found" as const,
						session: sessions.find(
							(candidate) => candidate.sessionId === target.sessionId,
						)!,
					})),
			);
			const flush = vi.spyOn(durableAppStorage, "flush").mockResolvedValue();
			const fixture = await createPaneAppRestartFixture(
				"/fixture/home",
				"fixture-proof",
			);
			expect(api.panels).toHaveLength(4);
			expect(api.getPanel(fixture.convertedPaneId)?.api.component).toBe(
				"terminal",
			);
			expect(api.getPanel(fixture.legacyPaneId)?.api.component).toBe(
				"terminal",
			);
			expect(fixture.legacyPaneId).toBe("launcher:fixture-proof");
			expect(api.getPanel(fixture.launcherPaneId)?.api.component).toBe(
				"launcher",
			);
			expect(api.activePanel?.id).toBe(fixture.convertedPaneId);
			expect(fixture.terminals).toHaveLength(3);
			expect(
				fixture.terminals.map(
					({ paneId }) => api.getPanel(paneId)?.api.isVisible,
				),
			).toEqual([true, true, true]);
			expect(sessions.map((value) => value.sessionClass)).toEqual(
				managed
					? ["managed", "managed", "standalone"]
					: ["standalone", "standalone", "standalone"],
			);
			expect(useStore.getState().layouts[fixture.spaceId]).toEqual(
				api.toJSON(),
			);
			expect(flush).toHaveBeenCalledOnce();
			const before = await snapshotPaneAppRestartFixture(fixture);
			api.fromJSON(api.toJSON());
			expect(await snapshotPaneAppRestartFixture(fixture)).toEqual(before);
			const claims = await preparePaneAppRestartClaims(fixture, "fixture-proof");
			expect(claims.cases).toHaveLength(6);
			for (const entry of claims.cases) {
				const pending = preparePaneAction(entry.paneId, "terminal.input");
				await claims.beforeReturn(`pane_action_${entry.idempotencyKey}`);
				const result = await pending();
				if (entry.mode === "refresh") expect(result.ok).toBe(true);
				else
					expect(result).toMatchObject({
						ok: false,
						error: { code: "pane_changed", retryable: false },
					});
				expect(api.getPanel(entry.paneId)?.api.component).toBe("terminal");
			}
			api.fromJSON(before.layout);
			const original = sessions[0];
			sessions[0] = { ...original, terminalEpoch: "replacement-epoch" };
			await expect(snapshotPaneAppRestartFixture(fixture)).rejects.toThrow(
				"Restart replaced the terminal identity",
			);
			sessions[0] = {
				...original,
				sessionClass:
					original.sessionClass === "managed" ? "standalone" : "managed",
			};
			await expect(snapshotPaneAppRestartFixture(fixture)).rejects.toThrow(
				"Terminal is not healthy after attachment",
			);
			sessions[0] = original;
			api.getPanel(fixture.convertedPaneId)!.api.updateParameters({
				binding: hmuxStandaloneBinding("unrelated", "fixture"),
			});
			await expect(snapshotPaneAppRestartFixture(fixture)).rejects.toThrow(
				"Wrong explicit pane target",
			);
			api.getPanel(fixture.convertedPaneId)!.api.updateParameters({
				sessionId: "unrelated",
			});
			await expect(snapshotPaneAppRestartFixture(fixture)).rejects.toThrow(
				"Pane target changed across app restart",
			);
		},
	);
});
