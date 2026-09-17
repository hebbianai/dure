import { asRecord as recordValue } from "@/lib/payloadGuards";
import type { PluginSidebarSelection } from "@/lib/plugins/pluginSidebarSelection";
import {
	normalizeSidebarTab,
	type SidebarTab,
} from "@/lib/sidebar/sidebarTabs";

export type WindowSidebarScope = "main" | "auxiliary";

export interface WindowSidebarSnapshot {
	open: boolean;
	width: number;
	tab: SidebarTab;
	pluginSelection: PluginSidebarSelection | null;
}

export const MAIN_WINDOW_SIDEBAR_DEFAULT: WindowSidebarSnapshot = {
	open: true,
	width: 300,
	tab: "spaces",
	pluginSelection: null,
};

export const AUXILIARY_WINDOW_SIDEBAR_DEFAULT: WindowSidebarSnapshot = {
	open: false,
	width: 300,
	tab: "spaces",
	pluginSelection: null,
};

const MIN_SIDEBAR_WIDTH = 207;
const MAX_SIDEBAR_WIDTH = 560;

/**
 * 아이콘 레일의 폭(px) — 테두리 포함.
 *
 * 사이드바를 접었을 때의 폭이 곧 이 값이다(레일만 남으므로). 두 곳에 따로
 * 박아 두면 조용히 어긋나서 접힘 상태에서 레일 옆에 1~2px 틈이 생기므로
 * 여기 한 곳에서만 정한다. 사용자 지시로 50 → 52 (2026-07-31).
 */
export const SIDEBAR_RAIL_WIDTH = 52;

export function windowSidebarScope(search: string): WindowSidebarScope {
	const params = new URLSearchParams(search);
	return params.has("desktop") ||
		params.has("diff") ||
		params.has("popout") ||
		params.has("panel")
		? "auxiliary"
		: "main";
}

export function normalizeWindowSidebarWidth(value: unknown): number {
	const width =
		typeof value === "number" && Number.isFinite(value)
			? Math.round(value)
			: MAIN_WINDOW_SIDEBAR_DEFAULT.width;
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function parsePluginSelection(value: unknown): PluginSidebarSelection | null {
	const selection = recordValue(value);
	return selection &&
		typeof selection.containerKey === "string" &&
		selection.containerKey.length > 0 &&
		(selection.viewId === null || typeof selection.viewId === "string")
		? { containerKey: selection.containerKey, viewId: selection.viewId }
		: null;
}

function parseStoredState(
	raw: string | null,
	fallback: WindowSidebarSnapshot,
	legacy: boolean,
): WindowSidebarSnapshot | undefined {
	if (!raw) return undefined;
	try {
		const envelope = recordValue(JSON.parse(raw));
		const state = recordValue(envelope?.state);
		if (!state) return undefined;
		const openKey = legacy ? "sidebarOpen" : "open";
		const widthKey = legacy ? "sidebarWidth" : "width";
		const tabKey = legacy ? "sidebarTab" : "tab";
		if (!(openKey in state) && !(widthKey in state) && !(tabKey in state)) {
			return undefined;
		}
		const open = state[openKey];
		const pluginSelection = legacy
			? null
			: parsePluginSelection(state.pluginSelection);
		const tab = normalizeSidebarTab(state[tabKey]);
		return {
			open: typeof open === "boolean" ? open : fallback.open,
			width:
				typeof state[widthKey] === "number"
					? normalizeWindowSidebarWidth(state[widthKey])
					: fallback.width,
			// Older snapshots remember only "plugin", not which plugin was chosen.
			tab: tab === "plugin" && !pluginSelection ? "spaces" : tab,
			pluginSelection,
		};
	} catch {
		return undefined;
	}
}

/** Resolve a workspace window's initial presentation without consulting shared
 * structural state. Auxiliary Desktop windows deliberately ignore main-window
 * persistence and start rail-only. */
export function initialWindowSidebarState(
	scope: WindowSidebarScope,
	dedicatedMainState: string | null,
	legacySharedState: string | null,
): WindowSidebarSnapshot {
	if (scope === "auxiliary") {
		return { ...AUXILIARY_WINDOW_SIDEBAR_DEFAULT };
	}
	return (
		parseStoredState(dedicatedMainState, MAIN_WINDOW_SIDEBAR_DEFAULT, false) ??
		parseStoredState(legacySharedState, MAIN_WINDOW_SIDEBAR_DEFAULT, true) ?? {
			...MAIN_WINDOW_SIDEBAR_DEFAULT,
		}
	);
}

export function serializeWindowSidebarState(
	snapshot: WindowSidebarSnapshot,
): string {
	return JSON.stringify({
		state: {
			open: snapshot.open,
			width: normalizeWindowSidebarWidth(snapshot.width),
			tab: normalizeSidebarTab(snapshot.tab),
			pluginSelection: snapshot.pluginSelection,
		},
		version: 2,
	});
}
