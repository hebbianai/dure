import { type ReactNode, useEffect, useRef } from "react";
import { useBrowserViewport } from "@/components/panels/browser/useBrowserViewport";
import { browserFramePoint } from "@/lib/browser/browserFramePoint";
import type {
	BrowserPaneSession,
	BrowserPaneView,
} from "@/lib/browser/browserPaneSession";
import { t } from "@/lib/i18n";
import { showToast } from "@/lib/toast";

export function BrowserPageSurface({
	session,
	view,
	enabled,
	paneId,
	children,
}: {
	session: BrowserPaneSession;
	view: BrowserPaneView;
	enabled: boolean;
	/** The pane this surface fills, so its reports land in that pane. */
	paneId?: string;
	children?: ReactNode;
}) {
	const surface = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const composing = useRef<HTMLTextAreaElement | null>(null);
	const keys = useRef(new Set<string>());
	const frame = view.frame;
	const resizing = useBrowserViewport(surface, session, view, enabled);
	const send = (action: Parameters<BrowserPaneSession["input"]>[0]) => {
		const release =
			action.kind === "key_up" ||
			(action.kind === "mouse" && action.action.kind === "up");
		if (enabled && (!children || release) && frame && (!resizing || release))
			void session.input(action, frame.capture.page).catch(() => {});
	};
	const point = (
		event: { currentTarget: HTMLElement; clientX: number; clientY: number },
		outside = false,
	) =>
		frame
			? browserFramePoint(
					frame.capture,
					event.currentTarget.getBoundingClientRect(),
					event.clientX,
					event.clientY,
					outside,
				)
			: undefined;
	const button = (value: number) =>
		(["left", "middle", "right", "back", "forward"] as const)[value];
	const rawKey = (event: {
		key: string;
		ctrlKey: boolean;
		metaKey: boolean;
		altKey: boolean;
	}) =>
		Array.from(event.key).length !== 1 ||
		event.ctrlKey ||
		event.metaKey ||
		event.altKey;
	const release = () => {
		keys.current.clear();
		void session
			.release()
			.catch(() =>
				showToast(t("panels.browser.releaseFailed"), { ms: 5000, paneId }),
			);
	};
	useEffect(() => {
		keys.current.clear();
		composing.current = null;
	}, [view.control?.controller?.epoch, session]);
	return (
		<div
			ref={surface}
			className="relative min-h-0 flex-1 overflow-hidden bg-background focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring"
		>
			{frame ? (
				<div
					className="absolute inset-0"
					onPointerDown={(event) => {
						const location = point(event);
						const pressed = button(event.button);
						if (!enabled || resizing || !location || !pressed) return;
						event.preventDefault();
						input.current?.focus();
						event.currentTarget.setPointerCapture(event.pointerId);
						send({
							kind: "mouse",
							action: { kind: "down", button: pressed, ...location },
						});
					}}
					onPointerMove={(event) => {
						const location = point(
							event,
							event.currentTarget.hasPointerCapture(event.pointerId),
						);
						if (location)
							send({ kind: "mouse", action: { kind: "move", ...location } });
					}}
					onPointerUp={(event) => {
						const location = point(
							event,
							event.currentTarget.hasPointerCapture(event.pointerId),
						);
						const released = button(event.button);
						if (location && released)
							send({
								kind: "mouse",
								action: { kind: "up", button: released, ...location },
							});
						if (event.currentTarget.hasPointerCapture(event.pointerId))
							event.currentTarget.releasePointerCapture(event.pointerId);
					}}
					onPointerCancel={release}
					onContextMenu={(event) => event.preventDefault()}
					onWheel={(event) => {
						const location = point(event);
						if (!location || !enabled) return;
						event.stopPropagation();
						const unit =
							event.deltaMode === 1
								? 16
								: event.deltaMode === 2
									? frame.capture.viewport.height
									: 1;
						send({
							kind: "mouse",
							action: {
								kind: "wheel",
								...location,
								delta_x: event.deltaX * unit,
								delta_y: event.deltaY * unit,
							},
						});
					}}
				>
					<img
						src={frame.src}
						alt={t("panels.browser.pageView")}
						draggable={false}
						className="pointer-events-none h-full w-full object-contain object-left-top"
					/>
				</div>
			) : (
				<div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
					{t("panels.browser.waitingFrame")}
				</div>
			)}
			{/* Native composition cannot outlive its document and controller lease. */}
			<textarea
				key={JSON.stringify([view.page, view.control?.controller])}
				ref={input}
				aria-label={t("panels.browser.pageInput")}
				className="absolute top-0 left-0 size-px resize-none overflow-hidden opacity-0"
				tabIndex={enabled && frame && !resizing && !children ? 0 : -1}
				readOnly={!enabled || !frame || resizing || !!children}
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				onCompositionStart={(event) => {
					composing.current = event.currentTarget;
				}}
				onCompositionEnd={(event) => {
					const active = composing.current === event.currentTarget;
					composing.current = null;
					if (active && event.data)
						send({ kind: "insert_text", text: event.data });
					event.currentTarget.value = "";
				}}
				onChange={(event) => {
					if (
						composing.current === event.currentTarget ||
						(event.nativeEvent as InputEvent).isComposing
					)
						return;
					const text = event.currentTarget.value;
					event.currentTarget.value = "";
					if (text) send({ kind: "insert_text", text });
				}}
				onKeyDown={(event) => {
					if (
						!enabled ||
						resizing ||
						!frame ||
						composing.current === event.currentTarget ||
						event.nativeEvent.isComposing ||
						event.key === "Process" ||
						event.key === "Dead"
					)
						return;
					if (
						(event.metaKey || event.ctrlKey) &&
						event.key.toLowerCase() === "v"
					)
						return;
					if (rawKey(event)) {
						event.preventDefault();
						const key = event.code || event.key;
						keys.current.add(key);
						send({ kind: "key_down", key });
					}
				}}
				onKeyUp={(event) => {
					const key = event.code || event.key;
					if (keys.current.delete(key)) {
						event.preventDefault();
						send({ kind: "key_up", key });
					}
				}}
				onPaste={(event) => {
					if (!enabled) return;
					event.preventDefault();
					const text = event.clipboardData.getData("text/plain");
					if (text) send({ kind: "insert_text", text });
				}}
				onBlur={() => {
					composing.current = null;
					if (input.current) input.current.value = "";
					release();
				}}
			/>
			{!resizing && children}
		</div>
	);
}
