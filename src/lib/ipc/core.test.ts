import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {},
	invoke: mocks.invoke,
}));

const loadedObservation = {
	schemaVersion: 1,
	buildId: "0.1.4+123456789abc",
	sourceRevision: "123456789abc",
	worktreeOverlay: "clean",
	backendRuntimeFingerprint: `git-object-v1:${"a".repeat(40)}`,
};

describe("loaded frontend compatibility identity", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubGlobal("__DURE_FRONTEND_RUNTIME_OBSERVATION__", loadedObservation);
		mocks.invoke.mockReset();
		mocks.invoke.mockResolvedValue({
			name: "Dure",
			packageVersion: "0.1.4",
			protocolVersion: 1,
			buildId: loadedObservation.buildId,
			runtimeFingerprint: loadedObservation.backendRuntimeFingerprint,
			features: [
				"app.runtime-fingerprint-v1",
				"hmux.managed-create-advance-v1",
			],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("completes before CLI expiry when the dev-server observation never responds", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(() => new Promise<Response>(() => {}));
		vi.stubGlobal("fetch", fetch);
		const { appCompatibility: inspect } = await import("./core");
		let completed = false;
		const result = inspect(true).then((value) => {
			completed = true;
			return value;
		});

		await vi.advanceTimersByTimeAsync(7_000);

		expect(completed).toBe(true);
		expect(await result).toMatchObject({
			mode: "current",
			frontendBuildId: loadedObservation.buildId,
			frontendSourceRevision: loadedObservation.sourceRevision,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "reports a different checkout",
			fetchResult: {
				json: async () => ({
					...loadedObservation,
					buildId: "0.1.4+ffffffffffff",
					sourceRevision: "ffffffffffff",
					backendRuntimeFingerprint: `git-object-v1:${"f".repeat(40)}`,
				}),
			},
		},
		{
			name: "is disconnected",
			fetchResult: new Error("Vite unavailable"),
		},
	])("retains the loaded identity when Vite $name", async ({
		fetchResult,
	}) => {
		const fetchMock =
			fetchResult instanceof Error
				? vi.fn().mockRejectedValue(fetchResult)
				: vi.fn().mockResolvedValue(fetchResult);
		vi.stubGlobal("fetch", fetchMock);
		const { appCompatibility } = await import("./core");
		const { currentErrorReportAppMetadata } = await import(
			"@/lib/platform/errorIncident"
		);

		const compatibility = await appCompatibility(true);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(compatibility).toMatchObject({
			mode: "current",
			frontendBuildId: loadedObservation.buildId,
			frontendSourceRevision: loadedObservation.sourceRevision,
			frontendWorktreeOverlay: loadedObservation.worktreeOverlay,
			frontendRuntimeFingerprint: loadedObservation.backendRuntimeFingerprint,
		});
		expect(currentErrorReportAppMetadata().frontendBuildId).toBe(
			compatibility.frontendBuildId,
		);
	});

	it("still detects a changed native backend and unavailable capabilities", async () => {
		const { appCompatibility } = await import("./core");
		const initial = await appCompatibility(true);
		mocks.invoke.mockResolvedValue({
			...initial.backend,
			runtimeFingerprint: `git-object-v1:${"b".repeat(40)}`,
		});
		expect(await appCompatibility(true)).toMatchObject({
			mode: "version-skew",
			comparisonBasis: "runtime-fingerprint",
			frontendBuildId: loadedObservation.buildId,
		});

		mocks.invoke.mockRejectedValue(new Error("native backend unavailable"));
		expect(await appCompatibility(true)).toMatchObject({
			mode: "legacy",
			backend: null,
			frontendBuildId: loadedObservation.buildId,
		});
	});
});
