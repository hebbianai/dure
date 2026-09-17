import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	controlPlaneCensus: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/ipc")>();
	return {
		...original,
		hmux: {
			...original.hmux,
			controlPlaneCensus: mocks.controlPlaneCensus,
		},
	};
});

import { subscribeHmuxControlPlaneCensus } from "./hmuxControlPlaneCensusFeed";
import {
	readLatestHmuxControlPlaneCensusObservation,
	requestHmuxControlPlaneCensus,
	resetHmuxControlPlaneCensusObservationForTests,
} from "./hmuxControlPlaneCensusObservation";

const census = {
	policy: {
		activation: "local_bundled_or_installed_current" as const,
		signedReleaseFetch: "not_implemented" as const,
		signedPackageInstall: "blocked_missing_trust_root" as const,
	},
	sessions: [
		{
			sessionId: "session-secret-ready",
			workspaceId: "workspace-secret",
			lifecycle: "ready" as const,
			terminalEpoch: "epoch-secret",
			outputSeq: "1",
			capabilities: [],
		},
		{
			sessionId: "session-secret-exited",
			workspaceId: "workspace-secret",
			lifecycle: "exited" as const,
			terminalEpoch: "epoch-secret",
			outputSeq: "1",
			capabilities: [],
		},
	],
	protectedBuildIds: [],
	diagnostics: {
		catalogUs: 12_000,
		healthProjectionUs: 4_000,
		totalUs: 16_000,
		joinedExisting: false,
		sessionIdentity: "native-secret-diagnostic-session",
	},
};

describe("Hmux control-plane census performance observation", () => {
	beforeEach(() => {
		mocks.controlPlaneCensus.mockReset();
		resetHmuxControlPlaneCensusObservationForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("projects one successful request without notifying the operational feed", async () => {
		mocks.controlPlaneCensus.mockResolvedValue(census);
		vi.spyOn(Date, "now").mockReturnValue(1_728_000_000_000);
		const rawFeedListener = vi.fn();
		const unsubscribe = subscribeHmuxControlPlaneCensus(rawFeedListener);
		const requestReason = {
			source: "app_control_plane" as const,
			trigger: "initial" as const,
			windowRole: "main" as const,
			workspaceIdentity: "native-secret-reason-workspace",
		};

		await expect(
			requestHmuxControlPlaneCensus(requestReason),
		).resolves.toBe(census);

		expect(mocks.controlPlaneCensus).toHaveBeenCalledOnce();
		expect(readLatestHmuxControlPlaneCensusObservation()).toEqual({
			requestReason: {
				source: "app_control_plane",
				trigger: "initial",
				windowRole: "main",
			},
			receivedAtMs: 1_728_000_000_000,
			diagnostics: {
				catalogUs: 12_000,
				healthProjectionUs: 4_000,
				totalUs: 16_000,
				joinedExisting: false,
			},
			sessionCounts: { total: 2, ready: 1, exited: 1 },
		});
		expect(rawFeedListener).not.toHaveBeenCalled();
		expect(
			JSON.stringify(readLatestHmuxControlPlaneCensusObservation()),
		).not.toContain("secret");
		unsubscribe();
	});

	it("preserves the latest success when the next request fails", async () => {
		mocks.controlPlaneCensus
			.mockResolvedValueOnce({ ...census, diagnostics: undefined })
			.mockRejectedValueOnce(new Error("census failed"));
		await requestHmuxControlPlaneCensus({
			source: "session_recovery",
			trigger: "refresh",
			windowRole: "secondary",
		});
		const successful = readLatestHmuxControlPlaneCensusObservation();

		await expect(
			requestHmuxControlPlaneCensus({
				source: "session_recovery",
				trigger: "refresh",
				windowRole: "secondary",
			}),
		).rejects.toThrow("census failed");

		expect(readLatestHmuxControlPlaneCensusObservation()).toEqual(successful);
		expect(successful).not.toHaveProperty("diagnostics");
	});
});
