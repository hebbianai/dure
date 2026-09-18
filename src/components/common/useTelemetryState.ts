// React wiring for the anonymous-telemetry state (#961): the Settings switch
// and the first-launch notice both read the native state on mount and record
// a choice through the same call. A choice made in one surface reaches the
// other while both are mounted; the native side stays the authority.
import { useCallback, useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n";
import {
	type TelemetryChoice,
	type TelemetryState,
	telemetrySetChoice,
	telemetryState,
} from "@/lib/ipc/telemetry";

/** The public page that lists every event and how to turn telemetry off, in
 *  the reader's language where the docs tree has one (docs.json languages:
 *  en, cn, ko, jp). */
export function telemetryDocsUrl(lang: Lang): string {
	const locale =
		lang === "ko" ? "ko" : lang === "ja" ? "jp" : lang === "zh" ? "cn" : "en";
	return `https://docs.dureai.dev/${locale}/privacy-and-telemetry`;
}

const listeners = new Set<(state: TelemetryState) => void>();

function publish(state: TelemetryState): void {
	for (const listener of listeners) listener(state);
}

export function useTelemetryState(): {
	/** `null` until the native side answered, or forever outside Tauri. */
	state: TelemetryState | null;
	busy: boolean;
	choose: (choice: TelemetryChoice) => Promise<void>;
} {
	const [state, setState] = useState<TelemetryState | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let live = true;
		const listener = (next: TelemetryState) => {
			if (live) setState(next);
		};
		listeners.add(listener);
		telemetryState()
			.then((next) => {
				// A stand-in bridge may answer with nothing; that is "unknown".
				if (live && next) setState(next);
			})
			.catch(() => undefined);
		return () => {
			live = false;
			listeners.delete(listener);
		};
	}, []);
	const choose = useCallback(async (choice: TelemetryChoice) => {
		setBusy(true);
		try {
			publish(await telemetrySetChoice(choice));
		} catch {
			// The native side refused or is absent; the control stays as it was.
		} finally {
			setBusy(false);
		}
	}, []);
	return { state, busy, choose };
}
