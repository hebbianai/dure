// Dev-only notice showcase — ⌥⇧N puts every floating notice on screen at
// once, in the running app, drawn by the real components on the real tokens
// in whichever theme the window is in, each where the real one lands (owner
// asks 2026-09-12 "show them all in the app", 2026-09-13 "in their real
// places"). Window-level notices are real — the Toaster draws them from the
// app's own channels; pane-level forms are drawn onto the open panes. main.tsx installs it
// under import.meta.env.DEV only; nothing here ships. Sample copy is the
// keys the real callers use; the captions are dev English outside t().
import { Copy } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RestartPreparationBand } from "@/components/common/RestartPreparationNotice";
import { DesignModeCaptureCard } from "@/components/design/DesignModeCaptureCard";
import { Alert, FLOATING_SURFACE } from "@/components/ui/alert";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";
import { dismissToast, showErrorToast, showToast } from "@/lib/toast";
import {
	clearUpdateNotice,
	upsertUpdateNotice,
} from "@/lib/updates/updateNotice";

const SOURCE = "qa.noticeShowcase";
/** Long enough to look at; the toggle clears them well before. */
const HOLD_MS = 10 * 60_000;

function noop() {}

/** Arms the window-level notices the real Toaster draws from the app's own
 * channels (brief toasts, the update card). Returns the disarm. */
function armWindowNotices(): () => void {
	const ids = [
		showToast(t("common.copiedToClipboard"), HOLD_MS),
		showToast(t("sessions.hidden.hidExitedToast", { count: 3 }), HOLD_MS),
		showErrorToast(
			t("common.folderOpenFailed", { e: "ENOENT ~/project/missing" }),
		),
	];
	upsertUpdateNotice({
		sourceRef: SOURCE,
		revision: "1",
		title: t("updates.providerCli.title"),
		description: t("updates.agentTooling.installDescription"),
		impact: t("updates.providerCli.impact"),
		importance: "maintenance",
		primaryAction: {
			label: t("common.install"),
			progressLabel: t("common.install"),
			completion: "retain",
			run: noop,
		},
	});
	return () => {
		for (const id of ids) dismissToast(id);
		clearUpdateNotice(SOURCE);
	};
}

function Caption({ children }: { children: string }) {
	return (
		<span className="font-mono text-[10px] leading-4 text-muted-foreground">
			{children}
		</span>
	);
}

/** The content area of every visible pane (dockview's group content — the
 * same element qa.ts measures), re-read on resize and on a short clock,
 * since dockview relays out without resizing the body. */
function usePaneRects(): DOMRect[] {
	const [rects, setRects] = useState<DOMRect[]>([]);
	useEffect(() => {
		const read = () =>
			setRects(
				Array.from(
					document.querySelectorAll<HTMLElement>(".dv-content-container"),
				)
					.filter((el) => el.offsetWidth > 0 && el.offsetHeight > 0)
					.map((el) => el.getBoundingClientRect()),
			);
		read();
		const observer = new ResizeObserver(read);
		observer.observe(document.body);
		const clock = window.setInterval(read, 500);
		return () => {
			observer.disconnect();
			window.clearInterval(clock);
		};
	}, []);
	return rects;
}

/** The four pane-level forms, each drawn where the real one lands: the band
 * across a pane's top, the failures in a pane's top-right corner. Panes are
 * dealt round-robin; with fewer panes than samples the extras stack down
 * the same corner so all four stay visible. No panes: a column at the top. */
function PaneSamples() {
	const rects = usePaneRects();
	const samples: { kind: "band" | "corner"; node: ReactNode }[] = [
		{
			kind: "band",
			node: (
				<div
					className={`px-3 py-2 text-xs text-foreground ${FLOATING_SURFACE}`}
				>
					{t("panels.browser.pickInstructions")}
					<span className="ml-2 font-mono">button.primary</span>
				</div>
			),
		},
		{
			kind: "band",
			node: (
				<Alert
					surface="dock"
					className="pointer-events-auto"
					dismiss={{ label: t("common.close"), onClick: noop }}
				>
					{t("agents.conversation.sshFailed")}
				</Alert>
			),
		},
		{
			kind: "band",
			node: (
				<Alert
					surface="dock"
					className="pointer-events-auto"
					action={
						<IconButton title={t("terminal.recovery.copyDetails")} onClick={noop}>
							<Copy />
						</IconButton>
					}
				>
					{t("terminal.failure.connection")}
				</Alert>
			),
		},
		{
			kind: "band",
			node: (
				<Alert
					surface="dock"
					className="pointer-events-auto"
					dismiss={{ label: t("common.close"), onClick: noop }}
				>
					{t("workspace.quickCommands.unavailable")}
				</Alert>
			),
		},
	];
	if (rects.length === 0) {
		return (
			<div className="pointer-events-none fixed inset-x-0 top-20 z-[110] flex flex-col items-center gap-2">
				<Caption>no pane open — pane-level forms shown in a column</Caption>
				{samples.map((sample, index) => (
					<div key={index} className="w-[32rem] max-w-[calc(100vw-2.5rem)]">
						{sample.node}
					</div>
				))}
			</div>
		);
	}
	const perPane = new Map<number, number>();
	return (
		<>
			{samples.map((sample, index) => {
				const paneIndex = index % rects.length;
				const rect = rects[paneIndex];
				const stacked = perPane.get(paneIndex) ?? 0;
				perPane.set(paneIndex, stacked + 1);
				// The real notice is absolute inside the pane, so it can never be
				// wider than the pane; a fixed sample must be capped the same way
				// or it spills over the pane's left edge (owner screenshot 09-13).
				const style: CSSProperties = {
					position: "fixed",
					top: rect.top + 8 + stacked * 44,
					right: window.innerWidth - rect.right + 8,
					maxWidth: rect.width - 16,
					...(sample.kind === "band" ? { left: rect.left + 8 } : {}),
				};
				return (
					<div key={index} className="pointer-events-none z-[110]" style={style}>
						{sample.node}
					</div>
				);
			})}
		</>
	);
}

/** Height of the update card the real Toaster is showing, so the capture
 * card can sit directly above it in the same corner — its real place is that
 * corner too (the two overlap today; stacking is the open follow-up), and
 * beside it it collided with the brief toasts on a narrow window. */
function useUpdateCardHeight(): number {
	const [height, setHeight] = useState(0);
	useEffect(() => {
		const read = () => {
			const card = document.querySelector<HTMLElement>(
				'div[aria-live="polite"].right-5.bottom-5',
			);
			setHeight(card?.offsetHeight ?? 0);
		};
		read();
		const clock = window.setInterval(read, 500);
		return () => window.clearInterval(clock);
	}, []);
	return height;
}

function ShowcaseOverlay() {
	useEffect(armWindowNotices, []);
	const updateCardHeight = useUpdateCardHeight();
	return (
		<>
			<RestartPreparationBand />
			<PaneSamples />
			{/* A transformed ancestor is the containing block for `fixed`, so the
			    card keeps its own corner logic and lands above the update card. */}
			<div
				className="pointer-events-none fixed inset-0 z-[100]"
				style={{ transform: `translateY(-${updateCardHeight + 8}px)` }}
			>
				<DesignModeCaptureCard
					label="SidebarSessionRow"
					choice={{
						defaultId: "showcase",
						reason: "last_input",
						candidates: [
							{ id: "showcase", name: "Claude", provider: "claude-code" },
						],
					}}
					onSend={noop}
					onCopy={noop}
					onDismiss={noop}
				/>
			</div>
		</>
	);
}

function ShowcaseRoot() {
	const [on, setOn] = useState(false);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey)
				return;
			// ⌥⇧N by code, like ⌥⇧D: the key differs by layout.
			if (event.code !== "KeyN") return;
			event.preventDefault();
			setOn((value) => !value);
		};
		// Capture phase — ahead of the terminal (xterm) swallowing the key.
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);
	return on ? <ShowcaseOverlay /> : null;
}

/** Its own root beside the app's, so App stays untouched; toggled by ⌥⇧N. */
export function installNoticeShowcase(): void {
	const host = document.createElement("div");
	host.dataset.qa = "notice-showcase";
	document.body.append(host);
	createRoot(host).render(<ShowcaseRoot />);
}
