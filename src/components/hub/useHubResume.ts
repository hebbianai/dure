/**
 * Turning the hub back on when the app restarts, if it was on.
 *
 * The hub opens a network port, so it starts only when somebody asks — and it
 * always did. What it never did was survive the process: every restart left a
 * paired phone talking to a computer that had, from its side, simply gone
 * offline, with nothing on either screen to say why. The backend now records
 * the choice, and this replays it.
 *
 * Replaying opens nothing new. The record is written when somebody turns the
 * hub on and erased when they turn it off, so a hub that comes back is one the
 * person left on.
 *
 * # Only the main window, once
 *
 * Every window would call this. The command itself refuses to restart a running
 * hub — a second start would drop the phone that had just connected — but doing
 * the round trip once is the honest shape, and it matches every other hub hook
 * in this folder.
 */

import { useEffect } from "react";
import { hubResume } from "@/lib/ipc/system";
import { isMainWindow } from "@/lib/workspace/window/windows";

export function useHubResume(): void {
	useEffect(() => {
		if (!isMainWindow()) return;
		// A hub that cannot come back is one press away in settings; a failure
		// here must not become a dialog on somebody's first paint.
		void hubResume().catch((cause) => {
			console.warn("[hub] could not resume the hub:", cause);
		});
	}, []);
}
