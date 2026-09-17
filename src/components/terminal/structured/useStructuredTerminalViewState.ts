// StructuredTerminalView's designated store-wiring point (cluster wiring
// hook). Every global-store subscription the structured terminal surface
// needs lives here; the component consumes the returned values and keeps
// rendering only. Each selector stays its own useStore subscription so
// rerender semantics match the previous inline wiring exactly.
import type { HmuxSessionSummary } from "@/lib/ipc";
import { DEFAULT_TERMINAL_LINE_HEIGHT } from "@/lib/terminal/renderer/terminalFont";
import { useStore } from "@/store";

export function useStructuredTerminalViewState() {
	const fontSize = useStore((state) => state.terminalFontSize);
	const fontFamily = useStore(
		(state) => state.uiPrefs?.terminalFontFamily ?? "",
	);
	const lineHeight = useStore(
		(state) =>
			state.uiPrefs?.terminalLineHeight ?? DEFAULT_TERMINAL_LINE_HEIGHT,
	);
	const copyOnSelect = useStore((state) => state.terminalPrefs.copyOnSelect);
	const allowOsc52 = useStore((state) => state.terminalPrefs.osc52);
	// 터미널 편집 단축키의 재지정 권위. 구독으로 읽어 설정에서 조합을 바꾸면
	// 다음 키 입력부터 바로 그 조합이 먹는다.
	const shortcutOverrides = useStore((state) => state.shortcutOverrides);
	return {
		fontSize,
		fontFamily,
		lineHeight,
		copyOnSelect,
		allowOsc52,
		shortcutOverrides,
	};
}

/** Deferred store write on hmux session-metadata receipt — reads the store at
 *  call time exactly like the previous inline useStore.getState() call. */
export function publishHmuxSessionMetadata(metadata: HmuxSessionSummary) {
	useStore.getState().setHmuxSessionMetadata(metadata);
}
