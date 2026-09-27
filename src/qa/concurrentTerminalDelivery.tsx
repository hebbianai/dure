import { createRoot } from "react-dom/client";
import { configureTextEncoding, getTextEncoding } from "@bufbuild/protobuf/wire";
import { StructuredTerminalView } from "@/components/terminal/structured/StructuredTerminalView";
import { type HmuxSessionSummary, hmux } from "@/lib/ipc";
import { writeFile } from "@/lib/ipc/files";
import {
	decodeTerminalStateRecord,
	hasTerminalStateEnvelopeMagic,
} from "@/lib/terminal/protocol/terminalStateProtocol";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import type { TerminalWindowFocusProbe } from "@/lib/terminal/terminalWindowFocusProbe";

function check(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Actual native IPC and production cached WebView decoding, alongside a fresh
 * decoder of the same bytes. Inject a persistently failed shared text codec at
 * initial delivery and mid-stream; only production decoding may repair it.
 * No payloads are replaced or saved. The runner owns the hidden window,
 * disposable roots and all 28 shell generations. */
export async function runConcurrentTerminalDelivery(
	proof: string,
	home: string,
) {
	const originalAttach = hmux.attachStructuredTerminal;
	const originalNext = hmux.nextStructuredTerminalRecord;
	const originalEncoding = getTextEncoding();
	type DecoderFault = {
		phase: string;
		calls: number;
		recovered: boolean;
		encoding: ReturnType<typeof getTextEncoding>;
	};
	const decoderFaults: DecoderFault[] = [];
	let pendingDecoderFault: string | undefined;
	let activeDecoderFault: DecoderFault | undefined;
	const observeDecoderRecovery = () => {
		if (activeDecoderFault && getTextEncoding() !== activeDecoderFault.encoding) {
			check(activeDecoderFault.calls > 0, "Injected decoder was never read");
			activeDecoderFault.recovered = true;
			activeDecoderFault = undefined;
		}
	};
	const sessions: HmuxSessionSummary[] = [];
	const observers = new Map<string, number>();
	const failures: Array<{ stage: string; reason: string }> = [];
	const rounds: Array<Record<string, number>> = [];
	const retirements: Promise<void>[] = [];
	const synchronized = new Set<number>();
	const outputSessions = new Set<number>();
	const frames = Array<number>(28).fill(0);
	let totalRecords = 0;
	let totalBytes = 0;
	let maxRecordBytes = 0;
	let fallbackRecords = 0;
	let result: Record<string, unknown> = { result: "failed" };
	const container = document.createElement("div");
	container.style.cssText =
		"display:grid;grid-template-columns:repeat(7,320px)";
	document.body.append(container);
	const root = createRoot(container);
	const noteFailure = (stage: string, error: unknown) => {
		if (failures.length < 10) failures.push({ stage, reason: String(error) });
	};
	const waitFor = async (description: string, ready: () => boolean) => {
		const deadline = Date.now() + 30_000;
		while (!ready()) {
			check(failures.length === 0, `Stream failure during ${description}`);
			check(Date.now() < deadline, `Timed out: ${description}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	try {
		for (let index = 0; index < 28; index += 1) {
			const sessionId = `qa-stream-${proof}-${index}`;
			const created = await hmux.createManagedShell({
				idempotencyKey: sessionId,
				sessionId,
				workspaceId: `workspace-${proof}`,
				cwd: `${home}/successor-project`,
				columns: 160,
				rows: 48,
				terminalDefaultColors: { foregroundRgb: 0xffffff, backgroundRgb: 0 },
			});
			check(
				created.session.sessionId === sessionId &&
					created.session.workspaceId === `workspace-${proof}`,
				"Unexpected session identity",
			);
			sessions.push(created.session);
			check(
				created.session.stopFence !== undefined,
				"Missing owned generation",
			);
		}
		hmux.attachStructuredTerminal = async (request) => {
			const index = sessions.findIndex(
				(s) => s.sessionId === request.sessionId,
			);
			check(index >= 0, "Unowned attachment");
			observers.set(request.observerId, index);
			return originalAttach(request);
		};
		hmux.nextStructuredTerminalRecord = async (observerId) => {
			const raw = await originalNext(observerId);
			observeDecoderRecovery();
			if (Array.isArray(raw)) fallbackRecords += 1;
			const bytes = new Uint8Array(raw);
			totalRecords += 1;
			totalBytes += bytes.byteLength;
			maxRecordBytes = Math.max(maxRecordBytes, bytes.byteLength);
			// The independent oracle must not repair the injected fault before
			// production sees it. Resume checking once production replaces it.
			if (hasTerminalStateEnvelopeMagic(bytes) && !activeDecoderFault) {
				try {
					const { record } = decodeTerminalStateRecord(bytes);
					const index = observers.get(observerId);
					check(index !== undefined, "Unknown observer");
					check(
						record.terminalEpoch === sessions[index]?.stopFence?.terminalEpoch,
						"Terminal epoch changed or a record crossed observers",
					);
					if (record.body.case === "viewportFrame") {
						frames[index] = (frames[index] ?? 0) + 1;
						const frame = record.body.value;
						const graphemes = frame.tables?.graphemes ?? [];
						const text = frame.rows
							.map((row) =>
								row.cells
									.map((cell) => graphemes[cell.graphemeIndex]?.text ?? "")
									.join(""),
							)
							.join("\n");
						for (const match of text.matchAll(/STREAM_(\d+):/g)) {
							check(
								Number(match[1]) === index,
								"Output crossed session boundaries",
							);
						}
						if (
							text.includes(`STREAM_${index}:`) &&
							text.includes("한글") &&
							text.includes("🙂")
						) {
							outputSessions.add(index);
						}
					}
				} catch (error) {
					noteFailure("fresh_decode", error);
				}
			}
			if (pendingDecoderFault && hasTerminalStateEnvelopeMagic(bytes)) {
				const fault: DecoderFault = {
					phase: pendingDecoderFault, calls: 0, recovered: false,
					encoding: {
						...getTextEncoding(),
						decodeUtf8: () => {
							fault.calls += 1;
							throw new TypeError("Owned QA failed text decoder context");
						},
					},
				};
				decoderFaults.push(fault);
				activeDecoderFault = fault;
				pendingDecoderFault = undefined;
				configureTextEncoding(fault.encoding);
			}
			return raw;
		};
		const render = (round: number) =>
			root.render(
				sessions.map((session, index) => {
					const probe: TerminalWindowFocusProbe = {
						connect: () => () => {},
						onHydrationChange: () => {},
						onPresented: () => {},
						onSynchronized: () => {
							synchronized.add(index);
						},
						onError: (error) => noteFailure("production_surface", error),
					};
					return (
						<div key={`${round}-${index}`} style={{ width: 320, height: 240 }}>
							<StructuredTerminalView
								sessionId={session.sessionId}
								surfaceId={`stream-${round}-${index}`}
								binding={hmuxManagedBinding(
									session.sessionId,
									session.workspaceId,
									undefined,
									undefined,
									session.stopFence,
								)}
								inputDisabled
								windowFocusProbe={probe}
								onHmuxSessionExit={() =>
									noteFailure("lifecycle", "Unexpected fixture exit")
								}
								onStructuredSurfaceRetirement={(retirement) =>
									retirements.push(retirement)
								}
							/>
						</div>
					);
				}),
			);
		for (let round = 0; round < 3; round += 1) {
			if (round === 1) {
				// One failed read-only fetch permanently switches Tauri's window
				// transport to postMessage. Exercise its real native response path;
				// never fail/retry an input command or alter a terminal payload.
				const originalFetch = window.fetch;
				let injected = false;
				try {
					window.fetch = (input, options) => {
						if (
							!injected &&
							String(input) === "ipc://localhost/hmux_control_plane_census"
						) {
							injected = true;
							return Promise.reject(
								new TypeError("Owned QA custom-protocol interruption"),
							);
						}
						return originalFetch.call(window, input, options);
					};
					await hmux.controlPlaneCensus();
					check(injected, "Native IPC fallback was not exercised");
				} finally {
					window.fetch = originalFetch;
				}
			}
			const started = Date.now();
			synchronized.clear();
			outputSessions.clear();
			frames.fill(0);
			if (round === 1) pendingDecoderFault = "initial_delivery";
			render(round);
			await waitFor(
				"28 complete native snapshots",
				() => synchronized.size === 28,
			);
			if (round === 2) pendingDecoderFault = "live_stream";
			if (round === 0) {
				await Promise.all(
					sessions.map(async (session, index) => {
						await hmux.commandInput({
							sessionId: session.sessionId,
							workspaceId: session.workspaceId,
							expectedFence: session.stopFence,
							text: `exec stream-output ${index}`,
							submit: true,
						});
					}),
				);
			}
			await waitFor(
				"sustained Unicode output on every session",
				() =>
					outputSessions.size === 28 &&
					frames.every((count) => count >= 12) &&
					Date.now() - started >= 12_000,
			);
			check(failures.length === 0, "Terminal stream failed");
			observeDecoderRecovery();
			check(!pendingDecoderFault && !activeDecoderFault, "Decoder recovery did not finish");
			rounds.push({
				round,
				durationMs: Date.now() - started,
				synchronized: synchronized.size,
				outputSessions: outputSessions.size,
				frames: frames.reduce((a, b) => a + b, 0),
			});
			root.render(null);
			await waitFor(
				"all surfaces detached",
				() => retirements.length === (round + 1) * 28,
			);
			await Promise.all(retirements);
		}
		const census = await hmux.controlPlaneCensus();
		check(fallbackRecords > 0, "No postMessage byte-array responses observed");
		for (const owned of sessions) {
			const current = census.sessions.find(
				(s) => s.sessionId === owned.sessionId,
			);
			check(
				current?.lifecycle === "ready" &&
					current.stopFence?.hostInstanceId ===
						owned.stopFence?.hostInstanceId &&
					current.stopFence?.terminalEpoch === owned.stopFence?.terminalEpoch,
				"Original generation was replaced or exited",
			);
		}
		result = { result: "passed", sameHosts: true };
	} catch (error) {
		result = { result: "failed", error: String(error) };
	} finally {
		configureTextEncoding(originalEncoding);
		root.unmount();
		await Promise.allSettled(retirements);
		hmux.attachStructuredTerminal = originalAttach;
		hmux.nextStructuredTerminalRecord = originalNext;
		container.remove();
		for (const session of sessions) {
			if (!session.stopFence) continue;
			try {
				const stopped = await hmux.stopManaged(
					`qa-stream-stop-${proof}-${session.sessionId}`,
					session.sessionId,
					session.workspaceId,
					session.stopFence,
				);
				check(stopped.outcome === "stopped", "Owned shell did not stop");
			} catch (error) {
				result = { ...result, result: "failed", cleanupError: String(error) };
			}
		}
	}
	await writeFile(
		`${home}/recovery-result.json`,
		JSON.stringify({
			proof,
			...result,
			sessionCount: sessions.length,
			totalRecords,
			totalBytes,
			maxRecordBytes,
			fallbackRecords,
			decoderFaults: decoderFaults.map(({ phase, calls, recovered }) => ({ phase, calls, recovered })),
			rounds,
			failures,
		}),
	);
}
