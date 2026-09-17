import { useEffect, useState } from "react";
import { SpacesPane } from "@/components/spaces/SpacesPane";
import { Workspace } from "@/components/workspace/Workspace";
import { hmux, homeDir } from "@/lib/ipc";
import { qaLog } from "@/lib/qa/qaLog";
import {
	currentSpacesRowDrag,
	endSpacesRowDrag,
	parseSpacesDragPayload,
} from "@/lib/spaces/spacesDrag";
import { bindingFromPane } from "@/lib/terminal/terminalBinding";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { createHmuxStandaloneTerminalOn } from "@/lib/workspace/dock/standaloneShellTerminal";
import { getDragState } from "@/lib/workspace/pane/paneDragState";
import { enqueuePaneMove } from "@/lib/workspace/pane/paneMoveQueue";
import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";

const proof = new URLSearchParams(location.search).get("qaSpacesPaneMove");
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

interface PaneTerminalIdentity {
	paneId: string;
	sessionId: string;
	workspaceId: string;
	terminalEpoch: string;
}

interface TerminalObservation {
	phase: string;
	sessions: (PaneTerminalIdentity & { lifecycle: string; health: string })[];
}

function requireFact(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}

async function waitFor(message: string, ready: () => boolean) {
	const deadline = performance.now() + 10_000;
	while (!ready()) {
		requireFact(performance.now() < deadline, message);
		await delay();
	}
}

/** Actual WKWebView event propagation and production layout owners, using
 * synthetic DOM drag events. No global input, foreground activation or provider
 * prompt; the existing mouse-driven media scenario proves gesture delivery. */
export function SpacesPaneMoveQaRoot() {
	const [spaces, setSpaces] = useState<readonly string[]>([]);
	useEffect(() => {
		if (!proof) return;
		const evidence = {
			starts: 0,
			drops: 0,
			captureClears: 0,
			adds: 0,
			removes: 0,
			created: [] as PaneTerminalIdentity[],
			terminalGenerations: [] as TerminalObservation[],
		};
		const run = async () => {
			const home = await homeDir();
			requireFact(
				home.includes("/dure-spaces-pane-move.") && home.endsWith("/home"),
				"Spaces move QA escaped its disposable HOME",
			);
			await useStore.persist.rehydrate();
			const source = useStore.getState().addSpace({ name: "Move source" });
			const target = useStore
				.getState()
				.addSpace({ name: "Move target", activate: false });
			setSpaces([source, target]);
			await waitFor("QA workspaces did not mount", () =>
				Boolean(getDockview(source) && getDockview(target)),
			);
			const created = evidence.created;
			for (const space of [source, source, target]) {
				const session = await createHmuxStandaloneTerminalOn(
					getDockview(space)!,
					home,
					undefined,
					undefined,
					space,
				);
				created.push({
					paneId: session.panelId,
					sessionId: session.sessionId,
					workspaceId: session.workspaceId,
					terminalEpoch: session.terminalEpoch,
				});
			}
			const panelId = created[0].paneId;
			const expectedIds = created.map((session) => session.paneId).sort();
			const observeRuntime = async (phase: string) => {
				for (const expected of created) {
					const panes = [source, target].flatMap((space) =>
						getDockview(space)!.panels.filter(
							(pane) => pane.id === expected.paneId,
						),
					);
					requireFact(
						panes.length === 1,
						`Pane identity changed after ${phase}`,
					);
					const binding = bindingFromPane(dockPanelReference(panes[0]), [], []);
					requireFact(
						panes[0].api.component === "terminal" &&
							binding?.runtime === "hmux_standalone_v1" &&
							binding.source === "local" &&
							binding.sessionId === expected.sessionId &&
							binding.workspaceId === expected.workspaceId,
						`Pane target changed after ${phase}: ${expected.paneId}`,
					);
				}
				const inspected = await hmux.inspectSessionsExact(
					created.map(({ sessionId, workspaceId }) => ({
						sessionId,
						workspaceId,
					})),
				);
				requireFact(
					inspected.length === created.length,
					"Incomplete native session observation",
				);
				const sessions = inspected.map((inspection, index) => {
					const expected = created[index];
					requireFact(
						inspection.outcome === "found" &&
							inspection.session.sessionId === expected.sessionId &&
							inspection.session.workspaceId === expected.workspaceId,
						`Missing exact runtime after ${phase}`,
					);
					const session = inspection.session;
					requireFact(
						session.lifecycle === "ready" &&
							session.health === "current_healthy" &&
							session.sessionClass === "standalone" &&
							session.terminalEpoch === expected.terminalEpoch,
						`Terminal generation changed after ${phase}: ${expected.sessionId}`,
					);
					return {
						paneId: expected.paneId,
						sessionId: session.sessionId,
						workspaceId: session.workspaceId,
						terminalEpoch: session.terminalEpoch,
						lifecycle: session.lifecycle,
						health: session.health,
					};
				});
				evidence.terminalGenerations.push({ phase, sessions });
			};
			await observeRuntime("initial");
			const row = () =>
				document.querySelector<HTMLElement>(
					`[data-space-key="${panelId}"][draggable=true]`,
				);
			const section = (space: string) =>
				document.querySelector<HTMLElement>(
					`[data-space-desktop-section="${space}"]`,
				);
			await waitFor("Actual Spaces row or target missing", () =>
				Boolean(row() && section(target)),
			);
			const liveIds = (space: string) =>
				getDockview(space)!
					.panels.map((panel) => panel.id)
					.sort();
			const savedIds = (space: string) => {
				const saved = JSON.parse(
					localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null",
				);
				return Object.keys(saved?.state?.layouts?.[space]?.panels ?? {}).sort();
			};
			const snapshot = () => [liveIds(source), liveIds(target)];
			const checkPlacement = async (destination: string) => {
				await waitFor(
					"Drop did not move the pane to its destination",
					() =>
						Boolean(getDockview(destination)?.getPanel(panelId)) &&
						!getDockview(destination === source ? target : source)?.getPanel(
							panelId,
						),
				);
				await durableAppStorage.flush();
				requireFact(
					JSON.stringify(snapshot().flat().sort()) ===
						JSON.stringify(expectedIds),
					"Drop lost or duplicated a pane",
				);
				for (const space of [source, target])
					requireFact(
						JSON.stringify(savedIds(space)) === JSON.stringify(liveIds(space)),
						"Durable layout differs from Dockview",
					);
				requireFact(
					getDockview(destination)!.getPanel(panelId)?.params?.sessionId ===
						created[0].sessionId,
					"Move replaced the source session identity",
				);
			};
			const observations = [source, target].flatMap((space) => [
				getDockview(space)!.onDidAddPanel((panel) => {
					if (panel.id === panelId) evidence.adds += 1;
				}),
				getDockview(space)!.onDidRemovePanel((panel) => {
					if (panel.id === panelId) evidence.removes += 1;
				}),
			]);
			const start = () => {
				evidence.starts += 1;
			};
			const drop = () => {
				evidence.drops += 1;
			};
			const clearInCapture = () => {
				endSpacesRowDrag();
				evidence.captureClears += 1;
			};
			const drag = async (destination: string, raw?: string) => {
				const origin = row();
				const heading =
					section(destination)?.querySelector("h3,h4,h5") ??
					section(destination);
				requireFact(origin && heading, "Drag source or destination missing");
				const dataTransfer = new DataTransfer();
				origin.dispatchEvent(
					new DragEvent("dragstart", {
						bubbles: true,
						cancelable: true,
						dataTransfer,
					}),
				);
				requireFact(
					currentSpacesRowDrag()?.length === 1 && getDragState(),
					"Real row did not initialize its drag",
				);
				const parsed = parseSpacesDragPayload(
					dataTransfer.getData("text/plain"),
				);
				requireFact(
					parsed?.length === 1 && parsed[0].panelId === panelId,
					"Real row did not write the exact payload",
				);
				heading.dispatchEvent(
					new DragEvent("dragover", {
						bubbles: true,
						cancelable: true,
						dataTransfer,
					}),
				);
				if (raw !== undefined) dataTransfer.setData("text/plain", raw);
				window.addEventListener("drop", clearInCapture, true);
				try {
					heading.dispatchEvent(
						new DragEvent("drop", {
							bubbles: true,
							cancelable: true,
							dataTransfer,
						}),
					);
				} finally {
					window.removeEventListener("drop", clearInCapture, true);
					origin.dispatchEvent(
						new DragEvent("dragend", { bubbles: true, dataTransfer }),
					);
				}
				// Drain the existing move owner before asserting no-op behavior.
				await enqueuePaneMove(async () => undefined);
				await delay();
				requireFact(
					currentSpacesRowDrag() === null && getDragState() === null,
					"Drag identities were not cleaned",
				);
			};
			window.addEventListener("dragstart", start, true);
			window.addEventListener("drop", drop, true);
			try {
				await drag(target);
				await checkPlacement(target);
				await observeRuntime("outward");
				await waitFor(
					"Moved row did not converge",
					() =>
						row()
							?.closest("[data-space-desktop-section]")
							?.getAttribute("data-space-desktop-section") === target,
				);
				const beforeNoop = JSON.stringify(snapshot());
				await drag(target);
				requireFact(
					JSON.stringify(snapshot()) === beforeNoop,
					"Same-Space drop moved a pane",
				);
				await observeRuntime("same-space");
				await drag(source, "dure:{invalid");
				requireFact(
					JSON.stringify(snapshot()) === beforeNoop,
					"Invalid drop moved a pane",
				);
				await observeRuntime("invalid");
				await drag(source);
				await checkPlacement(source);
				await observeRuntime("returned");
				requireFact(
					evidence.starts === 4 &&
						evidence.drops === 4 &&
						evidence.captureClears === 4 &&
						evidence.adds === 2 &&
						evidence.removes === 2,
					"Unexpected drag event count",
				);
				qaLog("spaces-pane-move", {
					proof,
					result: "passed",
					...evidence,
					panes: expectedIds.length,
					persisted: true,
					sameSpaceNoop: true,
					invalidNoop: true,
					returned: true,
					input: "synthetic-dom-drag",
				});
			} finally {
				for (const observation of observations) observation.dispose();
				window.removeEventListener("dragstart", start, true);
				window.removeEventListener("drop", drop, true);
				endSpacesRowDrag();
			}
		};
		void run().catch((error) =>
			qaLog("spaces-pane-move", {
				proof,
				result: "failed",
				...evidence,
				error: String(error),
			}),
		);
	}, []);
	return (
		<div style={{ display: "flex", width: 1000, height: 700 }}>
			<div style={{ width: 320 }}>{spaces.length > 0 && <SpacesPane />}</div>
			{spaces.map((id) => (
				<div key={id} style={{ width: 340 }}>
					<Workspace desktopId={id} active={false} />
				</div>
			))}
		</div>
	);
}
