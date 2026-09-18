import { hmux } from "@/lib/ipc";
import {
	getDockview,
	waitForDesktopDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { getWorkspacePerformanceSnapshot } from "@/lib/workspace/performance/workspacePerformance";
import type { WorkspacePerformanceSnapshot } from "@/lib/workspace/performance/workspacePerformanceTypes";
import { useStore } from "@/store";
import type { WorkspacePerformanceFixture } from "./fixture";
import retentionProfiles from "./retentionProfiles.json";
import type { WorkspacePerformanceScenario } from "./scenario";
import { createWorkspacePerformanceSessions } from "./sessionRuntime";

type RetentionFixture = Pick<
	WorkspacePerformanceFixture,
	"spaces" | "activeSpaceId" | "panelIdsByDesktop"
>;

interface RetentionSample {
	ordinal: number;
	phase: "cycling" | "idle";
	atMs: number;
	activeSpaceId: string;
	contentHashes: Record<string, string>;
	totals: WorkspacePerformanceSnapshot["totals"];
	workspaceCache: WorkspacePerformanceSnapshot["workspaceCache"];
}

export interface WorkspaceRetentionEvidence {
	workload: "managed-shell-fake-tui";
	profile: keyof typeof retentionProfiles;
	expectedSamples: number;
	samples: RetentionSample[];
	released?: WorkspacePerformanceSnapshot["totals"];
}

/** Exercise the real renderer/Host, not a fake implementation of Codex's
 * evolving native app-server protocol. Other performance phases retain their
 * provider-driver contract and are not made green by this isolated workload. */
export function createWorkspaceRetentionSessions(
	scenario: WorkspacePerformanceScenario,
	runtime: Pick<typeof hmux, "createManagedShell" | "stopManaged"> = hmux,
) {
	return createWorkspacePerformanceSessions(scenario, {
		create: async (request) => {
			const receipt = await runtime.createManagedShell({
				idempotencyKey: request.idempotencyKey,
				sessionId: request.sessionId,
				workspaceId: request.workspaceId,
				cwd: request.cwd,
				columns: request.columns,
				rows: request.rows,
				terminalDefaultColors: request.terminalDefaultColors,
				terminalEnv: request.terminalEnv,
			});
			const { sessionClass, stopFence } = receipt.session;
			if (sessionClass !== "managed" || !stopFence) {
				throw new Error("retention shell lacks an exact managed stop fence");
			}
			return {
				state: "current",
				receipt: {
					...receipt,
					session: { ...receipt.session, sessionClass, stopFence },
				},
			};
		},
		stop: runtime.stopManaged,
	});
}

const pause = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(description: string, ready: () => boolean) {
	const deadline = performance.now() + 30_000;
	while (!ready()) {
		if (performance.now() >= deadline)
			throw new Error(`retention: ${description}`);
		await pause(50);
	}
}

async function visit(fixture: RetentionFixture, desktopId: string) {
	await waitFor(`Space tab ${desktopId} did not mount`, () =>
		Boolean(document.getElementById(`desktop-tab-${desktopId}`)),
	);
	const tab = document.getElementById(`desktop-tab-${desktopId}`);
	if (!tab) throw new Error(`retention: missing Space tab ${desktopId}`);
	// DOM navigation only; never acquire native focus on the user's desktop.
	if (useStore.getState().activeSpaceId !== desktopId) tab.click();
	await waitForDesktopDockview(desktopId, 30_000);
	await waitFor(`Space ${desktopId} did not paint`, () => {
		if (useStore.getState().activeSpaceId !== desktopId) return false;
		return fixture.panelIdsByDesktop[desktopId].every((id) => {
			const panel = getDockview(desktopId)?.getPanel(id);
			const surface = panel?.group.element.querySelector<HTMLElement>(
				"[data-testid=structured-terminal-presentation]",
			);
			return (
				surface !== null &&
				surface !== undefined &&
				Number(surface.dataset.terminalViewportRows) > 0 &&
				Boolean(
					surface
						.querySelector("[data-testid=structured-terminal-viewport]")
						?.textContent?.trim(),
				)
			);
		});
	});
	// Let the existing tier reconciler settle; do not override its budget.
	await pause(500);
}

async function contentHashes(fixture: RetentionFixture) {
	const entries = await Promise.all(
		fixture.panelIdsByDesktop[fixture.activeSpaceId].map(async (id) => {
			const panel = getDockview(fixture.activeSpaceId)?.getPanel(id);
			const text = panel?.group.element.querySelector(
				"[data-testid=structured-terminal-viewport]",
			)?.textContent;
			if (!text?.trim()) throw new Error(`retention: empty terminal ${id}`);
			const bytes = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(text),
			);
			return [
				id,
				Array.from(new Uint8Array(bytes), (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join(""),
			] as const;
		}),
	);
	return Object.fromEntries(entries);
}

export async function runWorkspaceRetention(fixture: RetentionFixture) {
	if (fixture.spaces.length < 2)
		throw new Error("retention requires multiple Spaces");
	const status = window.__DURE_WORKSPACE_PERFORMANCE_QA__;
	if (!status) throw new Error("retention QA status missing");
	const profileName =
		new URLSearchParams(window.location.search).get("retention") ?? "short";
	if (profileName !== "short" && profileName !== "extended") {
		throw new Error(`unknown retention profile: ${profileName}`);
	}
	const profile = retentionProfiles[profileName];
	const evidence: WorkspaceRetentionEvidence = {
		workload: "managed-shell-fake-tui",
		profile: profileName,
		expectedSamples: profile.returnSamples + profile.idleSamples,
		samples: [],
	};
	status.retention = evidence;
	const tour = async () => {
		for (const space of fixture.spaces) await visit(fixture, space.id);
		await visit(fixture, fixture.activeSpaceId);
	};
	status.phase = "retention_warmup";
	await tour();
	await tour();
	for (let ordinal = 0; ordinal < evidence.expectedSamples; ordinal++) {
		const phase = ordinal < profile.returnSamples ? "cycling" : "idle";
		if (phase === "cycling" && ordinal > 0) {
			status.phase = `retention_tour:${ordinal}`;
			await tour();
		} else if (ordinal > profile.returnSamples) {
			status.phase = "retention_idle_wait";
			await pause(profile.idleIntervalMs - profile.sampleWindowMs);
		}
		if (useStore.getState().activeSpaceId !== fixture.activeSpaceId) {
			throw new Error("retention: return Space changed during observation");
		}
		const hashes = await contentHashes(fixture);
		if (
			evidence.samples[0] &&
			JSON.stringify(hashes) !==
				JSON.stringify(evidence.samples[0].contentHashes)
		) {
			throw new Error("retention: fixed-content precondition changed");
		}
		const { totals, workspaceCache } = getWorkspacePerformanceSnapshot();
		evidence.samples.push({
			ordinal,
			phase,
			atMs: Date.now(),
			activeSpaceId: fixture.activeSpaceId,
			contentHashes: hashes,
			totals,
			workspaceCache,
		});
		status.phase = `retention_sample:${ordinal}`;
		// The native client bookends a footprint point with this exact phase.
		await pause(profile.sampleWindowMs);
	}
}

export async function assertRetentionSurfacesReleased() {
	await waitFor("terminal resources survived pane removal", () => {
		const { totals } = getWorkspacePerformanceSnapshot();
		return (
			totals.terminalSurfaces === 0 &&
			totals.hmuxObservers === 0 &&
			totals.webglContexts === 0
		);
	});
	const evidence = window.__DURE_WORKSPACE_PERFORMANCE_QA__?.retention;
	if (evidence) evidence.released = getWorkspacePerformanceSnapshot().totals;
}
