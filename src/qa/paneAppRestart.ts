import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import { hmux, homeDir } from "@/lib/ipc";
import { readFile, writeFile } from "@/lib/ipc/files";
import { qaLog } from "@/lib/qa/qaLog";
import { getHmuxPaneHealth } from "@/lib/terminal/hmuxPaneHealthStore";
import { bindingFromPane } from "@/lib/terminal/terminalBinding";
import { hmuxPaneHealthId } from "@/lib/terminal/terminalHealth";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { commitExplicitDockviewMutation } from "@/lib/workspace/dock/explicitDockviewCommit";
import { createHmuxStandaloneTerminalOn } from "@/lib/workspace/dock/standaloneShellTerminal";
import { paneActionSnapshot } from "@/lib/workspace/pane/paneActionRegistry";
import {
	openSplitLauncherOn,
	openSplitTerminalPanel,
} from "@/lib/workspace/pane/paneSplit";
import { withPreparedAppRestart } from "@/lib/workspace/window/appRestart";
import { durableAppStorage, useStore } from "@/store";

interface TerminalIdentity {
	paneId: string;
	sessionId: string;
	workspaceId: string;
	terminalEpoch: string;
	sessionClass: "standalone" | "managed";
}
interface RestartFixture {
	spaceId: string;
	convertedPaneId: string;
	legacyPaneId: string;
	launcherPaneId: string;
	terminals: TerminalIdentity[];
}

let beforePaneClaimReturn: ((reqId: string) => Promise<void>) | undefined;

/** QA delays only the return of a real native claim, never its authority. */
export async function claimPaneAppRestartRequest(reqId: string) {
	const claimed = await claimCliRequest(reqId);
	if (claimed) await beforePaneClaimReturn?.(reqId);
	return claimed;
}
type RestartBaseline = {
	schemaVersion: 1;
	proof: string;
} & (
	| { phase: "fresh" }
	| {
			phase: "prepared";
			fixture: RestartFixture;
			snapshot: Awaited<ReturnType<typeof snapshotPaneAppRestartFixture>>;
	  }
);

function check(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
async function waitFor(message: string, ready: () => boolean) {
	const deadline = Date.now() + 20_000;
	while (!ready()) {
		check(Date.now() < deadline, message);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function presentedPaneFrame(spaceId: string, paneId: string) {
	const health = getHmuxPaneHealth(hmuxPaneHealthId(spaceId, paneId));
	if (
		health?.state !== "live" ||
		health.terminalEpoch === undefined ||
		health.receivedSequence === undefined ||
		health.presentedSequence === undefined
	)
		return;
	return {
		paneId,
		state: health.state,
		terminalEpoch: health.terminalEpoch,
		receivedSequence: health.receivedSequence,
		presentedSequence: health.presentedSequence,
	};
}

export async function waitForPaneAppRestartAttachments(
	spaceId: string,
	paneIds: readonly string[],
	message: string,
) {
	try {
		await waitFor(message, () =>
			paneIds.every(
				(paneId) =>
					paneActionSnapshot(paneId)?.status === "attached" &&
					presentedPaneFrame(spaceId, paneId) !== undefined,
			),
		);
	} catch (cause) {
		// Capture only on failure. A missing action observation is unknown, not
		// evidence that its pane or runtime has exited.
		const api = getDockview(spaceId);
		const observation = {
			documentVisibility: document.visibilityState,
			activeSpaceId: useStore.getState().activeSpaceId,
			spaceId,
			panes: paneIds.map((paneId) => {
				const pane = api?.getPanel(paneId);
				const action = paneActionSnapshot(paneId);
				const health = getHmuxPaneHealth(hmuxPaneHealthId(spaceId, paneId));
				return {
					paneId,
					component: pane?.api.component ?? null,
					visible: pane?.api.isVisible ?? null,
					status: action?.status ?? null,
					error: action?.error?.slice(0, 2048) ?? null,
					health: health
						? {
								state: health.state,
								terminalEpoch: health.terminalEpoch ?? null,
								receivedSequence: health.receivedSequence ?? null,
								presentedSequence: health.presentedSequence ?? null,
							}
						: null,
				};
			}),
		};
		throw Object.assign(
			new Error(`${message}\n${JSON.stringify(observation)}`),
			{
				cause,
			},
		);
	}
}

function dock(spaceId: string) {
	const api = getDockview(spaceId);
	check(api, `Missing mounted workspace ${spaceId}`);
	return api;
}
function commit<Result>(spaceId: string, mutate: () => Result): Result {
	return commitExplicitDockviewMutation({
		desktopId: spaceId,
		api: dock(spaceId),
		mutate,
		targetChangedError: () => new Error("QA workspace changed during mutation"),
	});
}
function paneBinding(spaceId: string, paneId: string) {
	const panel = dock(spaceId).getPanel(paneId);
	check(panel?.api.component === "terminal", `Pane content changed: ${paneId}`);
	const binding = bindingFromPane(dockPanelReference(panel), [], []);
	check(
		(binding?.runtime === "hmux_standalone_v1" ||
			binding?.runtime === "hmux_managed_v1") &&
			binding.source === "local",
		`Wrong explicit pane target: ${paneId}`,
	);
	return binding;
}

function sessionClass(
	binding: ReturnType<typeof paneBinding>,
): TerminalIdentity["sessionClass"] {
	return binding.runtime === "hmux_managed_v1" ? "managed" : "standalone";
}

export async function preparePaneAppRestartClaims(
	fixture: RestartFixture,
	proof: string,
) {
	const api = dock(fixture.spaceId);
	const original = fixture.terminals.map((terminal) => ({
		...terminal,
		params: structuredClone(api.getPanel(terminal.paneId)!.params),
	}));
	const cases = original.slice(0, 2).flatMap(({ paneId }, index) =>
		(["refresh", "aba", "change"] as const).map((mode) => ({
			paneId,
			mode,
			idempotencyKey: `${proof}.claim.${index}.${mode}`,
		})),
	);
	const waitForInput = async (paneId: string, terminalEpoch: string) => {
		await waitFor("Replacement terminal did not become input-ready", () =>
			Boolean(
				presentedPaneFrame(fixture.spaceId, paneId)?.terminalEpoch ===
					terminalEpoch &&
					paneActionSnapshot(paneId)?.actions.includes("terminal.input"),
			),
		);
	};
	await Promise.all(
		original.map(({ paneId, terminalEpoch }) =>
			waitForInput(paneId, terminalEpoch),
		),
	);
	return {
		cases,
		async beforeReturn(reqId: string) {
			const scenario = cases.find(
				(entry) => reqId === `pane_action_${entry.idempotencyKey}`,
			);
			if (!scenario) return;
			const { paneId, mode } = scenario;
			const source = original.find((entry) => entry.paneId === paneId)!;
			const replace = async (target: (typeof original)[number]) => {
				commit(fixture.spaceId, () => {
					const panel = api.getPanel(paneId)!;
					api.replacePanel(panel.api, {
						component: "terminal",
						title: panel.title,
						params: structuredClone(target.params),
					});
				});
				await waitForInput(paneId, target.terminalEpoch);
			};
			if (mode === "refresh") {
				const pane = api.getPanel(paneId)!;
				pane.api.updateParameters({ ...pane.params });
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => resolve()),
				);
			} else {
				await replace(original[2]);
				if (mode === "aba") await replace(source);
			}
			qaLog("pane-app-claim", {
				proof,
				...scenario,
				fromSessionId: source.sessionId,
				toSessionId: paneBinding(fixture.spaceId, paneId).sessionId,
			});
		},
	};
}

export async function createPaneAppRestartFixture(
	home: string,
	proof: string,
): Promise<RestartFixture> {
	const spaceId = useStore
		.getState()
		.addSpace({ name: "Pane restart QA", activate: true });
	await waitFor("Normal App did not mount the new Space", () =>
		Boolean(getDockview(spaceId)),
	);
	const api = dock(spaceId);
	const target = { kind: "local", cwd: home } as const;
	const launcher = () =>
		commit(spaceId, () => {
			const existing = new Set(api.panels.map((pane) => pane.id));
			openSplitLauncherOn(api, target, { direction: "right" });
			const added = api.panels.filter((pane) => !existing.has(pane.id));
			check(
				added.length === 1 && added[0].api.component === "launcher",
				"Launcher creation did not reserve one pane",
			);
			return added[0];
		});
	const converted = launcher();
	check(
		/^pane-[A-Za-z0-9_-]+$/.test(converted.id),
		"New launcher has a type-dependent ID",
	);
	const convertedPaneId = converted.id;
	await openSplitTerminalPanel(spaceId, target, { replacement: converted.api });
	paneBinding(spaceId, convertedPaneId);

	// This historical ID is a fixture input, never a production ID constructor.
	const legacy = commit(spaceId, () =>
		api.addPanel({
			id: `launcher:${proof}`,
			component: "launcher",
			position: { referencePanel: convertedPaneId, direction: "right" },
			title: "Legacy pane",
			params: { cwd: home },
		}),
	);
	const legacyPaneId = legacy.id;
	await openSplitTerminalPanel(spaceId, target, { replacement: legacy.api });
	paneBinding(spaceId, legacyPaneId);
	const created = await createHmuxStandaloneTerminalOn(
		api,
		home,
		undefined,
		undefined,
		spaceId,
	);
	check(
		/^pane-[A-Za-z0-9_-]+$/.test(created.panelId),
		"New terminal has a type-dependent ID",
	);
	const launcherPaneId = launcher().id;
	const terminalPaneIds = [convertedPaneId, legacyPaneId, created.panelId];
	await waitForPaneAppRestartAttachments(
		spaceId,
		terminalPaneIds,
		"Created terminal panes did not attach",
	);
	const bindings = terminalPaneIds.map((paneId) => ({
		paneId,
		...paneBinding(spaceId, paneId),
	}));
	const sessions = await hmux.inspectSessionsExact(
		bindings.map(({ sessionId, workspaceId }) => ({ sessionId, workspaceId })),
	);
	check(
		sessions.length === bindings.length,
		"Incomplete created runtime observation",
	);
	const terminals = sessions.map((inspection, index) => {
		const expectedClass = sessionClass(bindings[index]);
		check(
			inspection.outcome === "found" &&
				typeof inspection.session.terminalEpoch === "string" &&
				inspection.session.sessionClass === expectedClass,
			"Created runtime is not observable",
		);
		return {
			paneId: bindings[index].paneId,
			sessionId: inspection.session.sessionId,
			workspaceId: inspection.session.workspaceId,
			terminalEpoch: inspection.session.terminalEpoch,
			sessionClass: expectedClass,
		};
	});
	commit(spaceId, () => api.getPanel(convertedPaneId)!.api.setActive());
	await durableAppStorage.flush();
	return { spaceId, convertedPaneId, legacyPaneId, launcherPaneId, terminals };
}

export async function snapshotPaneAppRestartFixture(fixture: RestartFixture) {
	const { spaceId, terminals } = fixture;
	const api = dock(spaceId);
	const inspections = await hmux.inspectSessionsExact(
		terminals.map(({ sessionId, workspaceId }) => ({ sessionId, workspaceId })),
	);
	check(
		inspections.length === terminals.length,
		"Incomplete exact runtime observation",
	);
	const sessions = inspections.map((inspection, index) => {
		const expected = terminals[index];
		const binding = paneBinding(spaceId, expected.paneId);
		check(
			binding.sessionId === expected.sessionId &&
				binding.workspaceId === expected.workspaceId &&
				sessionClass(binding) === expected.sessionClass,
			"Pane target changed across app restart",
		);
		check(
			inspection.outcome === "found",
			"Exact runtime disappeared across app restart",
		);
		const current = inspection.session;
		check(
			current.sessionId === expected.sessionId &&
				current.workspaceId === expected.workspaceId &&
				current.terminalEpoch === expected.terminalEpoch,
			"Restart replaced the terminal identity",
		);
		check(
			current.lifecycle === "ready" &&
				current.health === "current_healthy" &&
				current.sessionClass === expected.sessionClass,
			"Terminal is not healthy after attachment",
		);
		return {
			...expected,
			lifecycle: current.lifecycle,
			health: current.health,
		};
	});
	check(
		api.getPanel(fixture.launcherPaneId)?.api.component === "launcher",
		"Restoration launched an unselected pane",
	);
	const layout = structuredClone(api.toJSON());
	const presentations = terminals.map(({ paneId, terminalEpoch }) => {
		const presentation = presentedPaneFrame(spaceId, paneId);
		check(
			presentation?.terminalEpoch === terminalEpoch,
			`Terminal presentation is not current: ${paneId}`,
		);
		return presentation;
	});
	return {
		spaceId,
		activeSpaceId: useStore.getState().activeSpaceId,
		activePaneId: api.activePanel?.id,
		panes: api.panels
			.map((pane) => structuredClone(dockPanelReference(pane)))
			.sort((left, right) => left.id.localeCompare(right.id)),
		layout,
		durableLayout: structuredClone(useStore.getState().layouts[spaceId]),
		sessions,
		presentations,
	};
}

/** Runs beside the normal App root. Only first boot creates fixture panes; the
 * successor must hydrate them through normal persistence and runtime attach. */
export async function runPaneAppRestartProbe() {
	const proof = new URLSearchParams(location.search).get("qaPaneAppRestart");
	if (!import.meta.env.DEV || !proof) return;
	let phase = "startup";
	const realm = crypto.randomUUID();
	try {
		const home = await homeDir();
		check(
			/\/dure-pane-app-restart\.[^/]+\/home$/.test(home),
			"Disposable pane restart QA HOME required",
		);
		check(
			getCurrentWebviewWindow().label === "main",
			"Restart QA requires the normal main App window",
		);
		const baselinePath = `${home.slice(0, -5)}/pane-restart.json`;
		const baseline: RestartBaseline = JSON.parse(
			(await readFile(baselinePath)).content,
		);
		check(
			baseline.schemaVersion === 1 && baseline.proof === proof,
			"Restart fixture does not belong to this QA run",
		);
		await waitFor("Normal App workspace did not mount", () =>
			Boolean(getDockview(useStore.getState().activeSpaceId)),
		);
		await document.fonts.ready;
		const observation = {
			proof,
			realm,
			windowLabel: getCurrentWebviewWindow().label,
			userAgent: navigator.userAgent,
		};
		if (baseline.phase === "fresh") {
			phase = "create";
			const fixture = await createPaneAppRestartFixture(home, proof);
			phase = "prepare";
			await withPreparedAppRestart(async (verify) => {
				await verify();
				const before: RestartBaseline = {
					schemaVersion: 1,
					proof,
					phase: "prepared",
					fixture,
					snapshot: await snapshotPaneAppRestartFixture(fixture),
				};
				await writeFile(baselinePath, JSON.stringify(before));
				qaLog("pane-app-restart-before", {
					...observation,
					status: "prepared",
					...before,
				});
				// The external QA client owns the exact supervisor request. Keep the
				// product's document/input preparation until native process retirement.
				await new Promise<void>(() => {});
			});
		} else {
			check(baseline.phase === "prepared", "Unknown restart fixture phase");
			phase = "restore";
			const { fixture } = baseline;
			await waitFor("Saved Space did not restore", () =>
				Boolean(getDockview(fixture.spaceId)),
			);
			await waitForPaneAppRestartAttachments(
				fixture.spaceId,
				fixture.terminals.map(({ paneId }) => paneId),
				"Saved terminal panes did not reattach",
			);
			const after = await snapshotPaneAppRestartFixture(fixture);
			const claims = await preparePaneAppRestartClaims(fixture, proof);
			beforePaneClaimReturn = claims.beforeReturn;
			qaLog("pane-app-restart-after", {
				...observation,
				status: "observed",
				snapshot: after,
				claimCases: claims.cases,
			});
		}
	} catch (error) {
		const failure = {
			proof,
			realm,
			phase,
			status: "failed",
			error: String(error),
		};
		// Either pending client phase receives the original failure immediately.
		qaLog("pane-app-restart-before", failure);
		qaLog("pane-app-restart-after", failure);
	}
}
