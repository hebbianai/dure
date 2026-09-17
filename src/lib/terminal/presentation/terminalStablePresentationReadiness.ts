export interface TerminalStablePresentationReadinessState {
	disposed: boolean;
	onScreen: boolean;
	rehydrating: boolean;
	retainedRevealPending: boolean;
	rendererActivationPending: boolean;
	rendererPromotionRequired: boolean;
	geometryPolicyPending: boolean;
	geometryRevision: number;
	settledGeometryRevision: number;
	hydratingClass: boolean;
	fitSettlingClass: boolean;
	canonicalResizeSettlingClass: boolean;
}

export type TerminalStablePresentationBlocker =
	| "disposed"
	| "off_screen"
	| "rehydrating"
	| "retained_reveal"
	| "renderer_promotion"
	| "geometry_policy"
	| "geometry"
	| "hydrating_class"
	| "fit_settling_class"
	| "canonical_resize_settling_class";

/** Pure, inspectable definition of the terminal's stable-presentation gate. */
export function terminalStablePresentationBlockers(
	state: TerminalStablePresentationReadinessState,
): TerminalStablePresentationBlocker[] {
	const blockers: TerminalStablePresentationBlocker[] = [];
	if (state.disposed) blockers.push("disposed");
	if (!state.onScreen) blockers.push("off_screen");
	if (state.rehydrating) blockers.push("rehydrating");
	if (state.retainedRevealPending) blockers.push("retained_reveal");
	if (state.rendererPromotionRequired && state.rendererActivationPending) {
		blockers.push("renderer_promotion");
	}
	if (state.geometryPolicyPending) blockers.push("geometry_policy");
	if (state.settledGeometryRevision < state.geometryRevision) {
		blockers.push("geometry");
	}
	if (state.hydratingClass) blockers.push("hydrating_class");
	if (state.fitSettlingClass) blockers.push("fit_settling_class");
	if (state.canonicalResizeSettlingClass) {
		blockers.push("canonical_resize_settling_class");
	}
	return blockers;
}

export function terminalStablePresentationReady(
	state: TerminalStablePresentationReadinessState,
): boolean {
	return terminalStablePresentationBlockers(state).length === 0;
}
