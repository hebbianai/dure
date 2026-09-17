import { assertNeverManagedCreateAdvanceResolution } from "@/lib/hmux/managed/managedCreateResolution";
import {
	type HmuxManagedCreateReceipt,
	type HmuxManagedStopFenceV1,
	hmux,
} from "@/lib/ipc";
import { terminalDefaultColors } from "@/lib/terminal/state/terminalDefaultColors";
import { DARK_TERMINAL_PALETTE } from "@/lib/theme/terminalTheme";
import type { WorkspacePerformanceFixtureSession } from "./fixture";
import {
	type WorkspacePerformanceProvider,
	workspacePerformanceProviderForCell,
} from "./providers";
import type { WorkspacePerformanceScenario } from "./scenario";

const SESSION_CWD = "/tmp";
const QA_TERMINAL_DEFAULT_COLORS = terminalDefaultColors(DARK_TERMINAL_PALETTE);

interface SessionRuntime {
	create: typeof hmux.advanceManagedCreate;
	stop: typeof hmux.stopManaged;
}

const defaultRuntime: SessionRuntime = {
	create: hmux.advanceManagedCreate,
	stop: hmux.stopManaged,
};

class WorkspacePerformanceSessionSetupError extends Error {
	constructor(
		readonly setupError: unknown,
		readonly cleanupErrors: readonly unknown[],
	) {
		super("workspace performance session setup and exact compensation failed");
		this.name = "WorkspacePerformanceSessionSetupError";
	}
}

class WorkspacePerformanceSessionCleanupError extends Error {
	constructor(readonly cleanupErrors: readonly unknown[]) {
		super(
			`workspace performance exact session cleanup failed (${cleanupErrors.length})`,
		);
		this.name = "WorkspacePerformanceSessionCleanupError";
	}
}

export interface WorkspacePerformanceSessionLease {
	readonly sessions: readonly WorkspacePerformanceFixtureSession[];
	release(): Promise<void>;
}

export async function createWorkspacePerformanceSessions(
	scenario: WorkspacePerformanceScenario,
	runtime: SessionRuntime = defaultRuntime,
): Promise<WorkspacePerformanceSessionLease> {
	const created: HmuxManagedCreateReceipt[] = [];
	try {
		const sessions: WorkspacePerformanceFixtureSession[] = [];
		for (let desktop = 1; desktop <= scenario.desktopCount; desktop += 1) {
			for (let pane = 1; pane <= scenario.panesPerDesktop; pane += 1) {
				const provider: WorkspacePerformanceProvider =
					workspacePerformanceProviderForCell(desktop, pane).id;
				const sessionId = `dure-perf-${provider}-d${desktop}-p${pane}`;
				const workspaceId = `dure-perf-workspace-d${desktop}-p${pane}`;
				const resolution = await runtime.create({
					idempotencyKey: sessionId,
					sessionId,
					workspaceId,
					providerId: provider,
					permissionMode: "default",
					cwd: SESSION_CWD,
					command: provider,
					columns: 120,
					rows: 36,
					terminalEnv: {
						TERM: "xterm-256color",
						COLORTERM: "truecolor",
					},
					terminalDefaultColors: QA_TERMINAL_DEFAULT_COLORS,
				});
				let receipt: HmuxManagedCreateReceipt;
				let advanced = false;
				switch (resolution.state) {
					case "current":
						receipt = resolution.receipt;
						break;
					case "advanced":
						receipt = resolution.receipt;
						advanced = true;
						break;
					case "retry_same":
					case "rejected":
						throw new Error(
							`workspace performance managed create did not become current: ${resolution.state}`,
						);
					default:
						return assertNeverManagedCreateAdvanceResolution(resolution);
				}
				assertCreateReceipt(receipt, sessionId, workspaceId, advanced);
				if (receipt.outcome === "created") created.push(receipt);
				sessions.push({
					provider,
					desktop,
					pane,
					cwd: SESSION_CWD,
					session: receipt.session,
				});
			}
		}
		let releasePromise: Promise<void> | undefined;
		return {
			sessions,
			release: () => {
				releasePromise ??= releaseSessions(created, runtime.stop);
				return releasePromise;
			},
		};
	} catch (error) {
		const cleanupFailures = await stopCreatedSessions(created, runtime.stop);
		if (cleanupFailures.length === 0) throw error;
		throw new WorkspacePerformanceSessionSetupError(error, cleanupFailures);
	}
}

function assertCreateReceipt(
	receipt: HmuxManagedCreateReceipt,
	sessionId: string,
	workspaceId: string,
	advanced: boolean,
) {
	if (
		receipt.outcome !== "created" ||
		(advanced
			? receipt.idempotencyKey === sessionId ||
				receipt.session.sessionId === sessionId
			: receipt.idempotencyKey !== sessionId ||
				receipt.session.sessionId !== sessionId) ||
		receipt.session.workspaceId !== workspaceId ||
		receipt.session.sessionClass !== "managed" ||
		receipt.session.lifecycle !== "ready" ||
		!receipt.session.stopFence
	) {
		throw new Error(`invalid managed Hmux create receipt for ${sessionId}`);
	}
}

async function releaseSessions(
	created: readonly HmuxManagedCreateReceipt[],
	stop: SessionRuntime["stop"],
) {
	const failures = await stopCreatedSessions(created, stop);
	if (failures.length > 0) {
		throw new WorkspacePerformanceSessionCleanupError(failures);
	}
}

async function stopCreatedSessions(
	created: readonly HmuxManagedCreateReceipt[],
	stop: SessionRuntime["stop"],
) {
	const failures: unknown[] = [];
	for (const receipt of [...created].reverse()) {
		try {
			await stop(
				`qa-cancel-${receipt.idempotencyKey}`,
				receipt.session.sessionId,
				receipt.session.workspaceId,
				receipt.session.stopFence as HmuxManagedStopFenceV1,
			);
		} catch (error) {
			failures.push(error);
		}
	}
	return failures;
}
