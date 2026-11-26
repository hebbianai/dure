// The app icon's badge: how many agents a human is blocking, the count the
// Next up chip leads with. The badge belongs to the whole app rather than to
// a window, so the main window keeps it, as it keeps attention notifications.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { readNextUp } from "@/lib/agents/nextUpNavigation";
import { DEFAULT_NOTIFY_PREFS } from "@/lib/settings/notifyPrefs";
import {
	type DesktopPlatform,
	detectDesktopPlatform,
} from "@/lib/workspace/desktop/desktopPlatform";
import { useStore } from "@/store";

/** Only the Dock draws the count. Linux launchers find the app by a desktop
 * file name the bundle does not share, and Windows takes an overlay icon. */
export function supportsAppIconBadge(
	platform: DesktopPlatform = detectDesktopPlatform(),
): boolean {
	return platform === "macos";
}

/** The badge for a Needs you count. Zero clears it, since the Dock would draw
 * a "0"; finished turns stay off it, as they stay quiet on the chip. */
export function appIconBadgeCount(
	needsYou: number,
	enabled: boolean,
): number | undefined {
	return enabled && needsYou > 0 ? needsYou : undefined;
}

type SetAppIconBadge = (count: number | undefined) => Promise<void>;

const setWindowBadge: SetAppIconBadge = (count) =>
	getCurrentWindow().setBadgeCount(count);

function currentBadgeCount(): number | undefined {
	const prefs = { ...DEFAULT_NOTIFY_PREFS, ...useStore.getState().notifyPrefs };
	return appIconBadgeCount(readNextUp().needsYou.length, prefs.appIconBadge);
}

/** Keeps the badge on the Needs you count until cleanup, which clears it. The
 * first write always lands, so a badge an earlier page load left behind does
 * not outlive it. */
export function installAppIconBadge({
	setBadge = setWindowBadge,
	platform = detectDesktopPlatform(),
}: { setBadge?: SetAppIconBadge; platform?: DesktopPlatform } = {}): () => void {
	if (!supportsAppIconBadge(platform)) return () => undefined;
	let shown: number | undefined | null = null;
	const show = (count: number | undefined) => {
		if (count === shown) return;
		shown = count;
		setBadge(count).catch((error) => {
			console.warn("[badge] could not update the app icon badge", error);
		});
	};
	const sync = () => show(currentBadgeCount());
	sync();
	const stopApp = useStore.subscribe((state, previous) => {
		if (
			state.agents !== previous.agents ||
			state.notifyPrefs !== previous.notifyPrefs
		) {
			sync();
		}
	});
	const stopAttention = useAgentAttention.subscribe((state, previous) => {
		if (state.displayStates !== previous.displayStates) sync();
	});
	return () => {
		stopApp();
		stopAttention();
		show(undefined);
	};
}
