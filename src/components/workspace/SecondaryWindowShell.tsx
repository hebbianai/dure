import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "@/components/Toaster";
import { useAppLanguage } from "@/components/settings/useAppLanguage";
import { useRootDarkClass } from "@/lib/theme/themePreference";
import { nativeWindowTitle } from "@/lib/platform/windowAppearance";
import { cn } from "@/lib/utils";
import { chromeDragIntent } from "@/lib/workspace/window/windowChromeDrag";
import {
	startWebviewKeyboardFocus,
	startWindowSync,
} from "@/lib/workspace/window/windows";

/**
 * Shared boot sequence of the bare-root secondary windows (?diff, ?popout,
 * ?sessionWindow, ?scm). Each window is its own WebView document, so this has
 * to run once per window: the `.dark` class on this window's own `<html>`,
 * language init (i18n globals are per window — without it the window sticks
 * to Korean), keyboard first-responder recovery (a freshly created window
 * boots without the WebView as first responder → no input), cross-window
 * store sync via storage events, and the native window title (taskbar /
 * window switcher identity; failures ignored).
 *
 * Returns the language key. Callers put it as `key` on their root element
 * (normally `<SecondaryWindowShell key={lang}>`) so a language change both
 * re-renders the caller's `t()` copy and remounts the window subtree.
 */
export function useSecondaryWindowBoot(title: string): string {
	useRootDarkClass();
	const lang = useAppLanguage();
	useEffect(() => startWebviewKeyboardFocus(), []);
	useEffect(() => startWindowSync(), []);
	useEffect(() => {
		getCurrentWindow()
			.setTitle(nativeWindowTitle(title))
			.catch(() => {});
	}, [title]);
	return lang;
}

/**
 * Mousedown handler for a chrome drag strip: double-click maximizes, a plain
 * primary press starts the OS window drag (both failures ignored), presses on
 * interactive descendants are left alone (`chromeDragIntent`). Windows whose
 * maximize needs extra choreography pass `onToggleMaximize` — the resize
 * transaction around AgentSessionWindow's maximize stays at that caller.
 */
export function windowChromeDragHandler(onToggleMaximize?: () => void) {
	return (event: React.MouseEvent) => {
		const intent = chromeDragIntent(event);
		if (intent === undefined) return;
		if (intent === "toggle-maximize") {
			if (onToggleMaximize) onToggleMaximize();
			else getCurrentWindow().toggleMaximize().catch(() => {});
		} else {
			getCurrentWindow().startDragging().catch(() => {});
		}
	};
}

/**
 * Chrome column of a bare-root secondary window: the full-viewport flex
 * column plus the window-local Toaster (toasts are per window — without it
 * this window's feedback is silent). Slots only: headers, drag strips, and
 * bodies are composed by the caller as children; per-window skin goes through
 * `className` (e.g. popout's `bg-glass-pane`, the session window's shell
 * rounding).
 */
export function SecondaryWindowShell({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex h-screen w-screen flex-col bg-background text-foreground",
				className,
			)}
		>
			{children}
			<Toaster />
		</div>
	);
}
