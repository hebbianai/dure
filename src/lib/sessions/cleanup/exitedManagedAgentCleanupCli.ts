import type { UnlistenFn } from "@tauri-apps/api/event";
import { claimCliRequest, completeCliRequest } from "@/lib/cli/cliRequestBroker";
import {
	applyExitedManagedAgentCleanupSync,
	EXITED_MANAGED_AGENT_CLEANED_EVENT,
	executeExitedManagedAgentCleanup,
	previewExitedManagedAgentCleanup,
} from "@/lib/sessions/cleanup/exitedManagedAgentCleanupRuntime";
import { listenWhenReady as listen } from "@/lib/platform/tauriBridge";

const ACTION = "hmux.cleanup-exited";

interface CliRequest {
	reqId: string;
	action: string;
}

export interface ExitedManagedAgentCleanupCliRuntime {
	claim: typeof claimCliRequest;
	complete: typeof completeCliRequest;
	preview: typeof previewExitedManagedAgentCleanup;
	execute: typeof executeExitedManagedAgentCleanup;
}

const runtime: ExitedManagedAgentCleanupCliRuntime = {
	claim: claimCliRequest,
	complete: completeCliRequest,
	preview: previewExitedManagedAgentCleanup,
	execute: executeExitedManagedAgentCleanup,
};

export async function handleExitedManagedAgentCleanupCliRequest(
	reqId: string,
	deps: ExitedManagedAgentCleanupCliRuntime = runtime,
): Promise<void> {
	if (!(await deps.claim(reqId))) return;
	try {
		const plan = await deps.preview();
		const receipts = await deps.execute(plan.candidates);
		await deps.complete(
			reqId,
			{
				ok: true,
				cleanup: {
					candidateCount: plan.candidates.length,
					protectedManagedCount: plan.protectedManagedCount,
					receipts,
				},
			},
			ACTION,
		);
	} catch (error) {
		await deps.complete(
			reqId,
			{
				ok: false,
				error: {
					code: "hmux_exited_agent_cleanup_failed",
					message: error instanceof Error ? error.message : String(error),
				},
			},
			ACTION,
		);
	}
}

export async function startExitedManagedAgentCleanupCliBridge(): Promise<UnlistenFn> {
	const unlistenSync = await listen(
		EXITED_MANAGED_AGENT_CLEANED_EVENT,
		(event) => {
			void applyExitedManagedAgentCleanupSync(event.payload).catch((error) => {
				console.error("[exited managed Agent cleanup] sync failed", error);
			});
		},
	);
	let unlistenRequests: UnlistenFn;
	try {
		unlistenRequests = await listen<CliRequest>("cli:request", (event) => {
			if (event.payload.action === ACTION) {
				void handleExitedManagedAgentCleanupCliRequest(event.payload.reqId);
			}
		});
	} catch (error) {
		unlistenSync();
		throw error;
	}
	return () => {
		unlistenRequests();
		unlistenSync();
	};
}
