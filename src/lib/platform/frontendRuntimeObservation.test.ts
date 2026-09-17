import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

it("retains a detached immutable observation for the loaded module generation", async () => {
	const injected = {
		schemaVersion: 1,
		buildId: "0.1.4+123456789abc",
		sourceRevision: "123456789abc",
		worktreeOverlay: "clean",
		backendRuntimeFingerprint: `git-object-v1:${"a".repeat(40)}`,
	};
	vi.stubGlobal("__DURE_FRONTEND_RUNTIME_OBSERVATION__", injected);
	const { frontendRuntimeObservation } = await import("./frontendRuntimeObservation");
	const snapshot = { ...injected };
	injected.buildId = "0.1.4+ffffffffffff";
	vi.stubGlobal("__DURE_FRONTEND_RUNTIME_OBSERVATION__", undefined);

	expect(frontendRuntimeObservation).toEqual(snapshot);
	expect(Object.isFrozen(frontendRuntimeObservation)).toBe(true);
});

it("reports unknown provenance when running without compiled build metadata", async () => {
	vi.stubGlobal("__DURE_FRONTEND_RUNTIME_OBSERVATION__", undefined);
	const { frontendRuntimeObservation } = await import("./frontendRuntimeObservation");

	expect(frontendRuntimeObservation).toEqual({
		schemaVersion: 1,
		buildId: "0.0.0+unknown",
		sourceRevision: null,
		worktreeOverlay: "unknown",
		backendRuntimeFingerprint: null,
	});
});
