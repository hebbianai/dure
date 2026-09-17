import { useEffect, useId, useRef, useState } from "react";
import { FLOATING_SURFACE } from "@/components/ui/alert";
import { ErrorText } from "@/components/ui/error-text";
import {
	type BrowserElementCapture,
	captureBrowserElement,
	inspectBrowserElement,
} from "@/lib/browser/browserElementCapture";
import { browserFramePoint } from "@/lib/browser/browserFramePoint";
import type { BrowserPaneSession } from "@/lib/browser/browserPaneSession";
import type { BrowserFrame } from "@/lib/browser/browserResourceContract";
import type { CapturedElement } from "@/lib/design/designModeCapture";
import { t } from "@/lib/i18n";

export function BrowserElementPicker({
	session,
	frame,
	onCapture,
	onClose,
}: {
	session: BrowserPaneSession;
	frame: BrowserFrame;
	onCapture: (captured: BrowserElementCapture) => void;
	onClose: () => void;
}) {
	const instructions = useId();
	const surface = useRef<HTMLButtonElement>(null);
	const lifetime = useRef<AbortController | undefined>(undefined);
	const pending = useRef(false);
	const inspecting = useRef(false);
	const desiredPreview = useRef<
		{ frame: BrowserFrame; point: { x: number; y: number } } | undefined
	>(undefined);
	const [preview, setPreview] = useState<{
		frame: BrowserFrame;
		element: CapturedElement;
	}>();
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const active = new AbortController();
		lifetime.current = active;
		surface.current?.focus();
		return () => active.abort();
	}, []);
	const previewAt = async (point?: { x: number; y: number }) => {
		const active = lifetime.current;
		if (!active || active.signal.aborted || pending.current) return;
		desiredPreview.current = point ? { frame, point } : undefined;
		setPreview(undefined);
		if (inspecting.current) return;
		inspecting.current = true;
		try {
			while (
				desiredPreview.current &&
				!active.signal.aborted &&
				!pending.current
			) {
				const request = desiredPreview.current;
				try {
					const element = await inspectBrowserElement(
						session,
						request.frame,
						request.point,
						active.signal,
					);
					if (
						desiredPreview.current === request &&
						!active.signal.aborted &&
						!pending.current
					) {
						setPreview(element ? { frame: request.frame, element } : undefined);
						setFailed(false);
					}
				} catch {
					if (
						desiredPreview.current === request &&
						!active.signal.aborted &&
						!pending.current
					)
						setFailed(true);
				}
				if (desiredPreview.current === request) break;
			}
		} finally {
			inspecting.current = false;
		}
	};
	const capture = async (point?: { x: number; y: number }) => {
		const active = lifetime.current;
		if (!active || active.signal.aborted || pending.current) return;
		pending.current = true;
		desiredPreview.current = undefined;
		setPreview(undefined);
		setBusy(true);
		setFailed(false);
		try {
			const captured = await captureBrowserElement(
				session,
				frame,
				point,
				active.signal,
			);
			if (!active.signal.aborted && captured) onCapture(captured);
		} catch {
			if (!active.signal.aborted) setFailed(true);
		} finally {
			pending.current = false;
			if (!active.signal.aborted) setBusy(false);
		}
	};
	const visiblePreview =
		preview &&
		preview.frame.viewport.width === frame.viewport.width &&
		preview.frame.viewport.height === frame.viewport.height
			? preview.element
			: undefined;
	return (
		<>
			<button
				ref={surface}
				type="button"
				className="absolute inset-0 cursor-crosshair focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
				aria-label={t("panels.browser.pickElement")}
				aria-describedby={instructions}
				aria-disabled={busy}
				onPointerMove={(event) => {
					void previewAt(
						browserFramePoint(
							frame,
							event.currentTarget.getBoundingClientRect(),
							event.clientX,
							event.clientY,
						),
					);
				}}
				onPointerLeave={() => void previewAt()}
				onClick={(event) => {
					if (event.detail === 0) {
						void capture();
						return;
					}
					const point = browserFramePoint(
						frame,
						event.currentTarget.getBoundingClientRect(),
						event.clientX,
						event.clientY,
					);
					if (point) void capture(point);
				}}
				onContextMenu={(event) => event.preventDefault()}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						lifetime.current?.abort();
						onClose();
					}
				}}
			/>
			{visiblePreview && (
				<svg
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 h-full w-full text-ring"
					viewBox={`0 0 ${frame.viewport.width} ${frame.viewport.height}`}
					preserveAspectRatio="xMinYMin meet"
				>
					<rect
						x={visiblePreview.rect.x}
						y={visiblePreview.rect.y}
						width={visiblePreview.rect.width}
						height={visiblePreview.rect.height}
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						vectorEffect="non-scaling-stroke"
					/>
				</svg>
			)}
			<div
				id={instructions}
				className={`pointer-events-none absolute top-2 right-2 left-2 px-3 py-2 text-xs text-foreground ${FLOATING_SURFACE}`}
				aria-live="polite"
			>
				{busy ? t("common.loading") : t("panels.browser.pickInstructions")}
				{visiblePreview && (
					<span className="ml-2 font-mono">{visiblePreview.label}</span>
				)}
				{failed && <ErrorText>{t("ipc.browser.requestFailed")}</ErrorText>}
			</div>
		</>
	);
}
