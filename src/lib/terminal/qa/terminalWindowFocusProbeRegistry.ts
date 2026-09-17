import type { TerminalWindowFocusProbe } from "@/lib/terminal/terminalWindowFocusProbe";

interface TerminalWindowFocusProbeRegistration {
	readonly probe: TerminalWindowFocusProbe;
}

const registrations = new Map<string, TerminalWindowFocusProbeRegistration>();

/**
 * Window-local QA injection point for terminal surfaces created by Dockview.
 * The panel identity is known before React mounts the terminal, so native QA
 * can observe the same typed Host receipt and painted projection as the view.
 */
export function registerTerminalWindowFocusProbe(
	surfaceId: string,
	probe: TerminalWindowFocusProbe,
): () => void {
	if (registrations.has(surfaceId)) {
		throw new Error(
			`terminal window focus probe is already registered: ${surfaceId}`,
		);
	}
	const registration = { probe };
	registrations.set(surfaceId, registration);
	return () => {
		if (registrations.get(surfaceId) === registration) {
			registrations.delete(surfaceId);
		}
	};
}

export function terminalWindowFocusProbeForSurface(
	surfaceId: string,
): TerminalWindowFocusProbe | undefined {
	return registrations.get(surfaceId)?.probe;
}
