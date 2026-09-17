import { createRoot } from "react-dom/client";
import { StructuredTerminalView } from "@/components/terminal/structured/StructuredTerminalView";
import { t } from "@/lib/i18n";
import { type HmuxSessionSummary, hmux } from "@/lib/ipc";
import { writeFile } from "@/lib/ipc/files";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import type { TerminalWindowFocusProbe } from "@/lib/terminal/terminalWindowFocusProbe";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import { useStore } from "@/store";

async function waitFor(
	description: string,
	ready: () => boolean,
	timeout = 10_000,
) {
	const deadline = Date.now() + timeout;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function check(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Real WebView/store/native snapshots; only the attach refusal and unavailable
 * metadata are injected. Never signal a Host or alter a provider credential. */
export async function runManagedAttachmentHealthReturn(
	proof: string,
	home: string,
) {
	const originalAttach = hmux.attachStructuredTerminal;
	const episodes: Array<Record<string, unknown>> = [];
	let result: Record<string, unknown> = { result: "failed" };
	let ownedSession: HmuxSessionSummary | undefined;
	try {
		const sessionId = `qa-health-return-${proof}`;
		const workspaceId = `workspace-${proof}`;
		const created = await hmux.createManagedShell({
			idempotencyKey: sessionId,
			sessionId,
			workspaceId,
			cwd: `${home}/successor-project`,
			columns: 80,
			rows: 24,
			terminalDefaultColors: { foregroundRgb: 0xffffff, backgroundRgb: 0 },
		});
		ownedSession = created.session;
		check(
			ownedSession.stopFence !== undefined,
			"Missing owned shell generation",
		);
		const session = { ...ownedSession, stopFence: ownedSession.stopFence };
		check(
			session.sessionId === sessionId && session.workspaceId === workspaceId,
			"Unexpected session returned",
		);
		const healthySummary = async (): Promise<HmuxSessionSummary> => {
			const census = await hmux.controlPlaneCensus();
			const current = census.sessions.find(
				(entry) =>
					entry.sessionId === sessionId && entry.workspaceId === workspaceId,
			);
			check(
				current?.lifecycle === "ready" &&
					current.stopFence?.hostInstanceId ===
						session.stopFence.hostInstanceId &&
					current.stopFence?.terminalEpoch ===
						session.stopFence.terminalEpoch &&
					(current.health === "current_healthy" ||
						current.health === "compatible_old_healthy"),
				`Original Host generation is not healthy: ${JSON.stringify(current)}`,
			);
			return current;
		};
		for (const retryDirective of ["unknown", "retry_after_resync"] as const) {
			const summary = await healthySummary();
			useStore
				.getState()
				.setHmuxSessionMetadata({ ...summary, health: "stale_transport" });
			const container = document.createElement("div");
			container.style.cssText = "width:320px;height:180px";
			document.body.append(container);
			const root = createRoot(container);
			const retirements: Promise<void>[] = [];
			let accepting = false;
			let attempts = 0;
			let snapshots = 0;
			const failure =
				retryDirective === "unknown"
					? new Error("Owned QA unavailable attachment")
					: Object.assign(new Error("Owned QA endpoint unavailable"), {
							code: "hmux_endpoint_unavailable",
							retryDirective,
						});
			hmux.attachStructuredTerminal = async (request) => {
				check(
					request.sessionId === sessionId &&
						request.workspaceId === workspaceId,
					"Unowned attachment target",
				);
				attempts += 1;
				if (!accepting) throw failure;
				return originalAttach(request);
			};
			const probe: TerminalWindowFocusProbe = {
				connect: () => () => {},
				onHydrationChange: () => {},
				onPresented: () => {},
				onError: () => {},
				onSynchronized: () => {
					snapshots += 1;
				},
			};
			const errorVisible = () =>
				container.textContent?.includes(t("terminal.failure.connection")) ===
				true;
			const started = Date.now();
			const previousExhausted =
				workspacePerformance.snapshot().terminalRecovery?.counts.exhausted ?? 0;
			try {
				root.render(
					<StructuredTerminalView
						sessionId={sessionId}
						surfaceId={`health-${retryDirective}`}
						binding={hmuxManagedBinding(
							sessionId,
							workspaceId,
							undefined,
							undefined,
							session.stopFence,
						)}
						inputDisabled
						windowFocusProbe={probe}
						onStructuredSurfaceRetirement={(retirement) =>
							retirements.push(retirement)
						}
					/>,
				);
				await waitFor(
					"bounded attachment episode exhausted",
					() =>
						errorVisible() &&
						(workspacePerformance.snapshot().terminalRecovery?.counts
							.exhausted ?? 0) > previousExhausted,
					45_000,
				);
				const exhaustedAttempts = retryDirective === "unknown" ? 2 : 11;
				check(
					attempts === exhaustedAttempts,
					`Unexpected retry budget: ${attempts}`,
				);
				const outageMs = Date.now() - started;
				if (retryDirective !== "unknown")
					check(outageMs >= 25_000, "Retry backoff was skipped");
				accepting = true;
				// No root.render(), remount or refresh action follows publication:
				// the production Zustand subscription must wake the failed surface.
				useStore.getState().setHmuxSessionMetadata(await healthySummary());
				await waitFor(
					"healthy Host restores a native complete frame",
					() => snapshots > 0 && !errorVisible(),
				);
				check(
					attempts === exhaustedAttempts + 1,
					`Duplicate recovery: ${attempts}`,
				);
				episodes.push({
					retryDirective,
					outageMs,
					attempts,
					snapshots,
					errorCleared: true,
				});
			} finally {
				root.unmount();
				await Promise.all(retirements);
				hmux.attachStructuredTerminal = originalAttach;
				container.remove();
			}
		}
		await healthySummary();
		result = { result: "passed", episodes, sameHost: true, sessionCount: 1 };
	} catch (error) {
		result = { result: "failed", error: String(error), episodes };
	} finally {
		hmux.attachStructuredTerminal = originalAttach;
		if (ownedSession?.stopFence) {
			try {
				const stopped = await hmux.stopManaged(
					`qa-health-stop-${proof}`,
					ownedSession.sessionId,
					ownedSession.workspaceId,
					ownedSession.stopFence,
				);
				check(stopped.outcome === "stopped", "Owned shell did not stop");
			} catch (error) {
				result = { ...result, result: "failed", cleanupError: String(error) };
			}
		}
	}
	await writeFile(
		`${home}/recovery-result.json`,
		JSON.stringify({ proof, ...result }),
	);
}
