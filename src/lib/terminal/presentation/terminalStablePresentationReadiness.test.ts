import { describe, expect, it } from "vitest";
import {
	terminalStablePresentationBlockers,
	terminalStablePresentationReady,
	type TerminalStablePresentationReadinessState,
} from "./terminalStablePresentationReadiness";

const ready: TerminalStablePresentationReadinessState = {
	disposed: false,
	onScreen: true,
	rehydrating: false,
	retainedRevealPending: false,
	rendererActivationPending: false,
	rendererPromotionRequired: false,
	geometryPolicyPending: false,
	geometryRevision: 4,
	settledGeometryRevision: 4,
	hydratingClass: false,
	fitSettlingClass: false,
	canonicalResizeSettlingClass: false,
};

describe("terminal stable presentation readiness", () => {
	it("accepts a visible, hydrated, settled presentation", () => {
		expect(terminalStablePresentationReady(ready)).toBe(true);
		expect(terminalStablePresentationBlockers(ready)).toEqual([]);
	});

	it("does not wait for background WebGL promotion", () => {
		expect(
			terminalStablePresentationReady({
				...ready,
				rendererActivationPending: true,
			}),
		).toBe(true);
	});

	it("waits when WebGL was explicitly selected as the final backend", () => {
		expect(
			terminalStablePresentationBlockers({
				...ready,
				rendererActivationPending: true,
				rendererPromotionRequired: true,
			}),
		).toContain("renderer_promotion");
	});

	it("names every independent blocker for runtime diagnostics", () => {
		expect(
			terminalStablePresentationBlockers({
				...ready,
				disposed: true,
				onScreen: false,
				rehydrating: true,
				retainedRevealPending: true,
				rendererActivationPending: true,
				rendererPromotionRequired: true,
				geometryPolicyPending: true,
				geometryRevision: 5,
				settledGeometryRevision: 4,
				hydratingClass: true,
				fitSettlingClass: true,
				canonicalResizeSettlingClass: true,
			}),
		).toEqual([
			"disposed",
			"off_screen",
			"rehydrating",
			"retained_reveal",
			"renderer_promotion",
			"geometry_policy",
			"geometry",
			"hydrating_class",
			"fit_settling_class",
			"canonical_resize_settling_class",
		]);
	});
});
