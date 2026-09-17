import { createRoot } from "react-dom/client";
import { StructuredTerminalView } from "@/components/terminal/structured/StructuredTerminalView";
import { WorkspaceRuntimeProvider } from "@/components/workspace/WorkspaceRuntimeContext";
import { hmux } from "@/lib/ipc";
import { writeFile } from "@/lib/ipc/files";
import { homeDir } from "@/lib/ipc/git";
import { findRebootStaleManagedSource } from "@/lib/sessions/managed/managedRebootRecovery";
import {
	type TerminalPresentationRole,
	TerminalPresentationRoleStore,
} from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import type { TerminalWindowFocusProbe } from "@/lib/terminal/terminalWindowFocusProbe";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
async function waitFor(description: string, ready: () => boolean) {
	const deadline = Date.now() + 20_000;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
function check(condition: boolean, message: string) {
	if (!condition) throw new Error(message);
}

/** Own hidden WebView, real native attaches and counted snapshots. Only the
 * carrier-close injection and post-native receipt gate are synthetic. */
export async function runRecoveryAdmissionProbe() {
	const proof = new URLSearchParams(location.search).get("qaRecoveryAdmission");
	if (!import.meta.env.DEV || !proof) return;
	const exitQueued =
		new URLSearchParams(location.search).get("qaRecoveryExit") === "1";
	const home = await homeDir();
	check(
		/\/dure-recovery-admission\.[^/]+\/home$/.test(home),
		"Disposable QA home required",
	);
	if (new URLSearchParams(location.search).get("qaRecoveryHealthReturn") === "1") {
		const { runManagedAttachmentHealthReturn } = await import("./managedAttachmentHealthReturn");
		await runManagedAttachmentHealthReturn(proof, home);
		return;
	}
	const originalAttach = hmux.attachStructuredTerminal;
	const originalNext = hmux.nextStructuredTerminalRecord;
	const initialObservers = new Map<string, string>();
	const closures = new Map<string, ReturnType<typeof deferred<ArrayBuffer>>>();
	const gates = new Map<string, ReturnType<typeof deferred<void>>>();
	const starts: string[] = [];
	const recoveryObservers: string[] = [];
	const receipts: string[] = [];
	const synchronized = new Map<string, number>();
	const attachmentStarts = new Map<string, string[]>();
	const retired = new Set<string>();
	const exits = new Set<string>();
	const refusals: Array<Record<string, unknown>> = [];
	const retirements: Promise<void>[] = [];
	let active = 0;
	let peak = 0;
	let recovering = false;
	let draining = false;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const roleStore = new TerminalPresentationRoleStore();
	const sessions: Array<
		Awaited<ReturnType<typeof hmux.advanceManagedCreate>> & { state: "current" }
	> = [];
	let result: Record<string, unknown>;
	let stopDetail: (() => void) | undefined;
	try {
		for (let index = 0; index < 8; index += 1) {
			const conversationId = crypto.randomUUID();
			const created = await hmux.advanceManagedCreate({
				idempotencyKey: `qa-recovery-${proof}-${index}`,
				sessionId: `qa-recovery-${proof}-${index}`,
				workspaceId: `workspace-${proof}`,
				providerId: "codex",
				conversationId,
				permissionMode: "default",
				cwd: `${home}/successor-project`,
				command: `codex resume ${conversationId}`,
				columns: 80,
				rows: 24,
				terminalDefaultColors: { foregroundRgb: 0xffffff, backgroundRgb: 0 },
			});
			if (created.state !== "current")
				throw new Error("Expected owned session");
			check(
				created.receipt.outcome === "created" &&
					created.receipt.session.sessionId ===
						`qa-recovery-${proof}-${index}` &&
					created.receipt.session.workspaceId === `workspace-${proof}`,
				"QA does not own the returned session",
			);
			sessions.push(created);
		}
		const ids = sessions.map((created) => created.receipt.session.sessionId);
		const ownIds = new Set(ids);
		hmux.attachStructuredTerminal = async (request) => {
			check(ownIds.has(request.sessionId), "Unexpected native attach target");
			if (!recovering) {
				initialObservers.set(request.sessionId, request.observerId);
				closures.set(request.observerId, deferred<ArrayBuffer>());
				return originalAttach(request);
			}
			starts.push(request.sessionId);
			recoveryObservers.push(request.observerId);
			active += 1;
			peak = Math.max(peak, active);
			const gate = deferred<void>();
			gates.set(request.sessionId, gate);
			try {
				const receipt = await originalAttach(request);
				receipts.push(request.sessionId);
				if (!draining) await gate.promise;
				return receipt;
			} catch (cause) {
				const error = cause as {
					name?: string;
					message?: string;
					code?: string;
					retryDirective?: string;
					failure?: { code?: string; retryPosture?: string };
				};
				refusals.push({
					pane: ids.indexOf(request.sessionId),
					name: error?.name,
					message: error?.message?.split(home).join("<qa-home>"),
					code: error?.code,
					retryDirective: error?.retryDirective,
					failureCode: error?.failure?.code,
					retryPosture: error?.failure?.retryPosture,
				});
				throw cause;
			} finally {
				active -= 1;
			}
		};
		hmux.nextStructuredTerminalRecord = (observerId) => {
			const original = originalNext(observerId);
			const close = closures.get(observerId);
			return close ? Promise.race([original, close.promise]) : original;
		};
		const probes = ids.map(
			(id): TerminalWindowFocusProbe => ({
				onSurfaceAttachmentStarted: (observerId) => {
					const previous = attachmentStarts.get(id) ?? [];
					attachmentStarts.set(id, [...previous, observerId]);
				},
				onSurfaceRetirement: (observerId) => {
					retired.add(observerId);
				},
				connect: () => () => {},
				onHydrationChange: () => {},
				onPresented: () => {},
				onError: () => {},
				onSynchronized: () =>
					synchronized.set(id, (synchronized.get(id) ?? 0) + 1),
			}),
		);
		const render = (omitDisposed = false) =>
			root.render(
				<WorkspaceRuntimeProvider
					desktopId={`qa-recovery-${proof}`}
					active
					presentationRoleStore={roleStore}
					commitLayout={() => true}
				>
					{sessions.map((created, index) => {
						if (omitDisposed && index === 7) return null;
						const session = created.receipt.session;
						const role: TerminalPresentationRole =
							index === 6
								? "foreground"
								: index === 5
									? "hovered"
									: "background";
						return (
							<div key={session.sessionId} style={{ width: 320, height: 180 }}>
								<StructuredTerminalView
									sessionId={session.sessionId}
									surfaceId={`surface-${session.sessionId}`}
									binding={hmuxManagedBinding(
										session.sessionId,
										session.workspaceId,
										undefined,
										undefined,
										session.stopFence,
									)}
									presentationRole={role}
									inputDisabled
									onHmuxSessionExit={() => {
										exits.add(session.sessionId);
									}}
									windowFocusProbe={probes[index]}
									onStructuredSurfaceRetirement={(retirement) =>
										retirements.push(retirement)
									}
								/>
							</div>
						);
					})}
				</WorkspaceRuntimeProvider>,
			);
		render();
		await waitFor(
			"eight complete native snapshots",
			() => synchronized.size === 8,
		);
		recovering = true;
		if (new URLSearchParams(location.search).get("qaRecoveryDetail") === "1") {
			stopDetail = workspacePerformance.startTerminalRecoveryDetailCapture();
		}
		const close = new TextEncoder().encode(
			JSON.stringify({
				kind: "closed",
				code: "hmux_transport_closed",
				message: "Owned QA carrier interruption",
				retryDirective: "reconnect",
			}),
		).buffer;
		// Occupy the four slots before queuing the priority contenders. React's
		// effect order is deliberately not assumed to match session creation.
		for (const id of ids.slice(0, 4))
			closures.get(initialObservers.get(id) as string)?.resolve(close);
		await waitFor("four native recovery receipts", () => receipts.length >= 4);
		check(
			starts.length === 4 && peak === 4,
			`Admission cap violated: ${starts.length}/${peak}`,
		);
		const hoveredId = ids[5] as string;
		closures.get(initialObservers.get(hoveredId) as string)?.resolve(close);
		await waitFor(
			"hovered pane queued first",
			() => attachmentStarts.get(hoveredId)?.length === 2,
		);
		for (const id of [ids[4], ids[6], ids[7]] as string[])
			closures.get(initialObservers.get(id) as string)?.resolve(close);
		await waitFor("four queued replacement attachments", () =>
			ids.slice(4).every((id) => attachmentStarts.get(id)?.length === 2),
		);
		const disposedObserver = attachmentStarts.get(
			ids[7] as string,
		)?.[1] as string;
		render(true);
		await waitFor("queued pane disposed", () => retired.has(disposedObserver));
		if (exitQueued) {
			// Retire only the exact owned fixture generation while its replacement
			// observer is still waiting, before releasing any admission slot.
			const target = sessions[4]?.receipt.session;
			if (!target) throw new Error("Owned queued target missing");
			const stop = await hmux.stopManaged(
				`qa-exit-${proof}`,
				target.sessionId,
				target.workspaceId,
				target.stopFence,
			);
			check(
				stop.outcome === "stopped" &&
					stop.sessionId === target.sessionId &&
					stop.workspaceId === target.workspaceId &&
					stop.hostInstanceId === target.stopFence.hostInstanceId &&
					stop.terminalEpoch === target.stopFence.terminalEpoch,
				"Queued stop receipt does not match the owned generation",
			);
		}
		gates.get(starts[0] as string)?.resolve();
		await waitFor("next recovery admitted", () => starts.length >= 5);
		check(
			starts[4] === ids[6],
			`Selected pane delayed: fifth=${ids.indexOf(starts[4] as string)}, expected=6`,
		);
		draining = true;
		for (const gate of gates.values()) gate.resolve();
		await waitFor("independent recovered snapshots and terminal outcome", () =>
			ids
				.slice(0, 7)
				.every((id, index) =>
					exitQueued && index === 4
						? exits.has(id)
						: (synchronized.get(id) ?? 0) >= 2,
				),
		);
		check(
			starts.length === 7 && !starts.includes(ids[7] as string),
			"Disposed waiter attached or duplicate recovery",
		);
		check(
			new Set(recoveryObservers).size === 7 &&
				recoveryObservers.every(
					(id) => ![...initialObservers.values()].includes(id),
				),
			"Observers were shared",
		);
		const census = await hmux.controlPlaneCensus();
		for (const session of census.sessions.filter(
			(entry) => ownIds.has(entry.sessionId) && entry.lifecycle === "ready",
		)) {
			check(
				session.manifestLifecycle === "ready" &&
					session.hostProcessAlive !== false,
				"Expected a live native source for missed-handshake admission",
			);
			// Model a missed discovery handshake while the real Host/PTY remains
			// attached. Transport failure must not authorize provider replacement.
			check(
				findRebootStaleManagedSource(
					[
						{
							...session,
							lifecycle: "unavailable",
							health: "stale_transport",
							inputAllowed: false,
						},
					],
					session,
				) === undefined,
				"Live Host admitted to automatic reboot replacement",
			);
		}
		check(
			sessions.every((created) =>
				census.sessions.some(
					(session) =>
						session.sessionId === created.receipt.session.sessionId &&
						(exitQueued && session.sessionId === ids[4]
							? session.lifecycle === "exited"
							: session.stopFence?.hostInstanceId ===
									created.receipt.session.stopFence.hostInstanceId &&
								session.lifecycle === "ready"),
				),
			),
			"Host generation changed",
		);
		result = {
			result: "passed",
			sessionCount: 8,
			recovered: exitQueued ? 6 : 7,
			exitedWhileQueued: exits.size,
			peak,
			nativeRecoveryRequests: starts.length,
			order: starts.map((id) => ids.indexOf(id)),
			uniqueObservers: recoveryObservers.length,
			diagnostics: workspacePerformance.snapshot().terminalRecovery,
			refusals,
		};
		const counts = workspacePerformance.snapshot().terminalRecovery?.counts;
		check(
			counts?.queued === 4 &&
				counts.admitted === 7 &&
				counts.cancelled === 1 &&
				counts.backendAttachRequests === 7 &&
				counts.exhausted === 0,
			"Recovery diagnostics do not match native requests and admission outcomes",
		);
	} catch (error) {
		result = {
			result: "failed",
			error: String(error),
			peak,
			nativeRecoveryRequests: starts.length,
			synchronized: [...synchronized.values()],
			refusals,
			exits: exits.size,
		};
	} finally {
		stopDetail?.();
		draining = true;
		for (const gate of gates.values()) gate.resolve();
		root.unmount();
		await Promise.all(retirements);
		hmux.attachStructuredTerminal = originalAttach;
		hmux.nextStructuredTerminalRecord = originalNext;
		container.remove();
	}
	await writeFile(
		`${home}/recovery-result.json`,
		JSON.stringify({ proof, ...result }),
	);
}
