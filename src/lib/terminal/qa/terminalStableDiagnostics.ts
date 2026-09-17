import {
	terminalStablePresentationBlockers,
	type TerminalStablePresentationReadinessState,
} from "@/lib/terminal/presentation/terminalStablePresentationReadiness";

interface TerminalStableDiagnosticSource {
	id: string;
	desktopId?: string;
	panelId?: string;
	readState(): TerminalStablePresentationReadinessState;
	readDetails?(): unknown;
}

const sources = new Map<string, TerminalStableDiagnosticSource>();

function readTerminalStableDiagnostic(source: TerminalStableDiagnosticSource) {
	const state = source.readState();
	const blockers = terminalStablePresentationBlockers(state);
	return {
		id: source.id,
		desktopId: source.desktopId,
		panelId: source.panelId,
		ready: blockers.length === 0,
		blockers,
		state,
		details: source.readDetails?.(),
	};
}

export function registerTerminalStableDiagnostic(
	source: TerminalStableDiagnosticSource,
): () => void {
	sources.set(source.id, source);
	return () => {
		if (sources.get(source.id) === source) sources.delete(source.id);
	};
}

export function terminalStableDiagnosticSnapshot() {
	return Array.from(sources.values(), readTerminalStableDiagnostic);
}

/** Reads one pane without forcing layout diagnostics in every mounted terminal. */
export function terminalStableDiagnosticForPanel(panelId: string) {
	for (const source of sources.values()) {
		if (source.panelId === panelId) return readTerminalStableDiagnostic(source);
	}
	return undefined;
}
