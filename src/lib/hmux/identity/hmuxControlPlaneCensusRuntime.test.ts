// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import type { HmuxControlPlaneCensus } from "@/lib/ipc";
import { useStore } from "@/store";
import { hmuxSessionSummaryFixture } from "@/test/agentFixtures";
import { installHmuxControlPlaneCensusRuntime } from "./hmuxControlPlaneCensusRuntime";

const mocks = vi.hoisted(() => ({
	requestHmuxControlPlaneCensus: vi.fn(),
}));

vi.mock(
	"@/lib/hmux/identity/hmuxControlPlaneCensusObservation",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/hmux/identity/hmuxControlPlaneCensusObservation")
		>()),
		requestHmuxControlPlaneCensus: mocks.requestHmuxControlPlaneCensus,
	}),
);

const census = {
	policy: {
		activation: "local_bundled_or_installed_current" as const,
		signedReleaseFetch: "not_implemented" as const,
		signedPackageInstall: "blocked_missing_trust_root" as const,
	},
	sessions: [],
	protectedBuildIds: [],
} satisfies HmuxControlPlaneCensus;

function setVisibility(state: DocumentVisibilityState): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: state,
	});
}

afterEach(() => {
	setVisibility("visible");
	useStore.setState({ hmuxSessionMetadata: {} });
	mocks.requestHmuxControlPlaneCensus.mockReset();
	vi.restoreAllMocks();
});

describe("Hmux control-plane census runtime", () => {
	it("projects a complete census through one metadata store commit", async () => {
		setVisibility("visible");
		const completeCensus = {
			...census,
			sessions: Array.from({ length: 878 }, (_, index) =>
				hmuxSessionSummaryFixture({
					workspaceId: "workspace",
					sessionId: `session-${index}`,
				}),
			),
		} satisfies HmuxControlPlaneCensus;
		mocks.requestHmuxControlPlaneCensus.mockResolvedValue(completeCensus);
		let metadataCommits = 0;
		const unsubscribe = useStore.subscribe((current, previous) => {
			if (current.hmuxSessionMetadata !== previous.hmuxSessionMetadata) {
				metadataCommits += 1;
			}
		});
		const stop = installHmuxControlPlaneCensusRuntime();

		try {
			await vi.waitFor(() =>
				expect(
					Object.keys(useStore.getState().hmuxSessionMetadata),
				).toHaveLength(878),
			);
			expect(metadataCommits).toBe(1);
			const initialMetadata = useStore.getState().hmuxSessionMetadata;
			const unchangedKey = hmuxSessionMetadataKey("workspace", "session-1");
			const unchangedEntry = initialMetadata[unchangedKey];

			mocks.requestHmuxControlPlaneCensus.mockResolvedValue({
				...completeCensus,
				policy: { ...completeCensus.policy, currentBuildId: "identical" },
			});
			window.dispatchEvent(new FocusEvent("focus"));
			await vi.waitFor(() =>
				expect(document.documentElement.dataset.hmuxCurrentBuild).toBe(
					"identical",
				),
			);
			expect(metadataCommits).toBe(1);
			expect(useStore.getState().hmuxSessionMetadata).toBe(initialMetadata);

			mocks.requestHmuxControlPlaneCensus.mockResolvedValue({
				...completeCensus,
				policy: { ...completeCensus.policy, currentBuildId: "changed" },
				sessions: completeCensus.sessions.map((session, index) =>
					index === 0 ? { ...session, outputSeq: "2" } : session,
				),
			});
			window.dispatchEvent(new FocusEvent("focus"));
			await vi.waitFor(() =>
				expect(document.documentElement.dataset.hmuxCurrentBuild).toBe(
					"changed",
				),
			);
			expect(metadataCommits).toBe(2);
			expect(useStore.getState().hmuxSessionMetadata[unchangedKey]).toBe(
				unchangedEntry,
			);
		} finally {
			stop();
			unsubscribe();
		}
	});

	it("labels initial, focus, and foreground requests without changing the route", async () => {
		setVisibility("visible");
		const request = vi.fn().mockResolvedValue(census);
		const apply = vi.fn();
		const stop = installHmuxControlPlaneCensusRuntime({
			request,
			apply,
			windowRole: () => "secondary",
			warn: vi.fn(),
		});
		await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));

		window.dispatchEvent(new FocusEvent("focus"));
		await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
		setVisibility("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(3));

		expect(request).toHaveBeenNthCalledWith(1, {
			source: "app_control_plane",
			trigger: "initial",
			windowRole: "secondary",
		});
		expect(request).toHaveBeenNthCalledWith(2, {
			source: "app_control_plane",
			trigger: "window_focus",
			windowRole: "secondary",
		});
		expect(request).toHaveBeenNthCalledWith(3, {
			source: "app_control_plane",
			trigger: "visibility_foreground",
			windowRole: "secondary",
		});
		stop();
	});

	it("suppresses hidden, overlapping, and disposed requests", async () => {
		setVisibility("hidden");
		let resolve: ((value: HmuxControlPlaneCensus) => void) | undefined;
		const request = vi.fn(
			() =>
				new Promise<HmuxControlPlaneCensus>((done) => {
					resolve = done;
				}),
		);
		const apply = vi.fn();
		const stop = installHmuxControlPlaneCensusRuntime({
			request,
			apply,
			windowRole: () => "main",
			warn: vi.fn(),
		});
		expect(request).not.toHaveBeenCalled();

		window.dispatchEvent(new FocusEvent("focus"));
		expect(request).not.toHaveBeenCalled();
		setVisibility("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		expect(request).toHaveBeenCalledOnce();
		window.dispatchEvent(new FocusEvent("focus"));
		document.dispatchEvent(new Event("visibilitychange"));
		expect(request).toHaveBeenCalledOnce();

		resolve?.(census);
		await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
		stop();
		window.dispatchEvent(new FocusEvent("focus"));
		expect(request).toHaveBeenCalledOnce();
	});
});
