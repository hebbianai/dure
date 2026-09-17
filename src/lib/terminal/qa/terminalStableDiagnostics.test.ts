import { describe, expect, it, vi } from "vitest";
import {
	registerTerminalStableDiagnostic,
	terminalStableDiagnosticForPanel,
} from "./terminalStableDiagnostics";

const readyState = {
	disposed: false,
	onScreen: true,
	rehydrating: false,
	retainedRevealPending: false,
	rendererActivationPending: false,
	rendererPromotionRequired: false,
	geometryPolicyPending: false,
	geometryRevision: 1,
	settledGeometryRevision: 1,
	hydratingClass: false,
	fitSettlingClass: false,
	canonicalResizeSettlingClass: false,
};

describe("terminalStableDiagnosticForPanel", () => {
	it("reads only the requested pane's expensive details", () => {
		const firstDetails = vi.fn(() => ({ pane: "first" }));
		const secondDetails = vi.fn(() => ({ pane: "second" }));
		const unregisterFirst = registerTerminalStableDiagnostic({
			id: "terminal-1",
			panelId: "panel-1",
			readState: () => readyState,
			readDetails: firstDetails,
		});
		const unregisterSecond = registerTerminalStableDiagnostic({
			id: "terminal-2",
			panelId: "panel-2",
			readState: () => readyState,
			readDetails: secondDetails,
		});

		try {
			expect(terminalStableDiagnosticForPanel("panel-2")?.details).toEqual({
				pane: "second",
			});
			expect(firstDetails).not.toHaveBeenCalled();
			expect(secondDetails).toHaveBeenCalledOnce();
		} finally {
			unregisterFirst();
			unregisterSecond();
		}
	});
});
