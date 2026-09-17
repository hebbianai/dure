import { useStore } from "@/store";

/** 설정이 Terminal 우선이고 xterm이 포커스된 경우 앱 단축키를 삼키지 않는다. */
export function shouldYieldToTerminal(): boolean {
	if (!useStore.getState().uiPrefs?.shortcutTerminalFirst) return false;
	const element = document.activeElement as HTMLElement | null;
	return !!element?.closest(".xterm");
}
