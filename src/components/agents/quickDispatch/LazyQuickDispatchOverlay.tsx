import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { DureLoader } from "@/components/ui/dure-loader";
import { readShortcutOverrides } from "@/components/agents/quickDispatch/useQuickDispatch";
import {
	onQuickDispatchRequest,
	type QuickDispatchPrefill,
} from "@/lib/agents/quickDispatch/quickDispatchActivation";
import { onQuickDispatchProgress } from "@/lib/agents/quickDispatch/quickDispatchProgress";
import { t } from "@/lib/i18n";
import { matchesChord, shortcutChord } from "@/lib/settings/shortcutBindings";
import { shouldYieldToTerminal } from "@/lib/settings/shortcutPriority";

const QuickDispatchOverlay = lazy(() =>
	import("@/components/agents/quickDispatch/QuickDispatchOverlay").then(
		(module) => ({ default: module.QuickDispatchOverlay }),
	),
);

/** What the progress pill is currently saying. `sent` bridges the moment
 *  between Enter and the pipeline's first stage report; the rest mirror the
 *  pipeline's own stages (quickDispatchProgress.ts). */
type NoticeKind = "sent" | "naming" | "spawning" | "failed";

const NOTICE_COPY: Record<NoticeKind, string> = {
	sent: "agents.quickDispatch.dispatched",
	naming: "agents.quickDispatch.progress.naming",
	spawning: "agents.quickDispatch.progress.spawning",
	failed: "agents.quickDispatch.progress.failed",
};

const FAILED_NOTICE_MS = 6000;
// A dispatch that never reports done/failed (e.g. the webview reloaded
// mid-run and the resume owns it now) must not strand the pill forever.
const NOTICE_SAFETY_MS = 60_000;

/** Keep the quick-dispatch overlay's compose surface, attachment handling,
 *  and chip menus out of cold startup. Mirrors LazyNativeSearchDialog's
 *  activation story: this tiny launcher owns the global ⌘N keydown so the
 *  shortcut cannot disappear while the heavy chunk is still loading, and it
 *  unmounts the overlay entirely on close so every reopen starts clean.
 *  It also owns the live progress pill: the pipeline publishes its stage
 *  (naming → spawning → done/failed) and this always-mounted component
 *  renders it, so the gap between Enter and the pane opening is narrated. */
export function LazyQuickDispatchOverlay() {
	const [activation, setActivation] = useState<{
		key: number;
		prefill?: QuickDispatchPrefill;
	} | null>(null);
	const activationSequence = useRef(0);
	const [notice, setNotice] = useState<NoticeKind | null>(null);
	const activate = useCallback((prefill?: QuickDispatchPrefill) => {
		activationSequence.current += 1;
		setActivation({ key: activationSequence.current, prefill });
	}, []);
	const close = useCallback(() => setActivation(null), []);
	const showDispatchedNotice = useCallback(() => setNotice("sent"), []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const chord = shortcutChord("quick-dispatch", readShortcutOverrides());
			if (!matchesChord(chord, event) || shouldYieldToTerminal()) return;
			event.preventDefault();
			activate();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [activate]);

	// Menus reach the same surface through the request bus rather than
	// mounting the overlay themselves — one owner of `open`, one lazy chunk.
	useEffect(() => onQuickDispatchRequest(activate), [activate]);

	useEffect(
		() =>
			onQuickDispatchProgress(({ stage }) => {
				setNotice(stage === "done" ? null : stage);
			}),
		[],
	);

	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(
			() => setNotice(null),
			notice === "failed" ? FAILED_NOTICE_MS : NOTICE_SAFETY_MS,
		);
		return () => clearTimeout(timer);
	}, [notice]);

	return (
		<>
			{notice !== null && (
				// The progress pill is a floating notice like any other: the toast
				// surface, neutral while the pipeline works and destructive when it
				// fails (owner audit 2026-09-13 — it had been a popover pill).
				<Alert
					surface="toast"
					tone={notice === "failed" ? "destructive" : "neutral"}
					role="status"
					className="pointer-events-none fixed top-4 left-1/2 z-[110] -translate-x-1/2"
				>
					<span className="flex items-center gap-2">
						{notice !== "failed" && (
							<DureLoader decorative className="text-muted-foreground" />
						)}
						{t(NOTICE_COPY[notice])}
					</span>
				</Alert>
			)}
			{activation && (
				<Suspense
					fallback={
						<div
							role="status"
							className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] text-xs text-muted-foreground"
						>
							{t("common.loading")}
						</div>
					}
				>
					<QuickDispatchOverlay
						key={activation.key}
						open
						prefill={activation.prefill}
						onClose={close}
						onDispatched={showDispatchedNotice}
					/>
				</Suspense>
			)}
		</>
	);
}
