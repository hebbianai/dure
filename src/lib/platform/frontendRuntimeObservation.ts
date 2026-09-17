import { createFrontendRuntimeObservation } from "@/contracts/frontendRuntimeObservation.mjs";

/** Identity of the loaded frontend, never the dev server's changing checkout. */
export const frontendRuntimeObservation = Object.freeze(
	createFrontendRuntimeObservation(
		typeof __DURE_FRONTEND_RUNTIME_OBSERVATION__ === "undefined"
			? {
					buildId: "0.0.0+unknown",
					sourceRevision: null,
					worktreeOverlay: "unknown",
					backendRuntimeFingerprint: null,
				}
			: __DURE_FRONTEND_RUNTIME_OBSERVATION__,
	),
);
