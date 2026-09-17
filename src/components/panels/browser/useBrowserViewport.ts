import {
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type {
	BrowserPaneSession,
	BrowserPaneView,
} from "@/lib/browser/browserPaneSession";
import {
	type BrowserViewport,
	browserViewport,
} from "@/lib/browser/browserViewport";

/** Resizing is a controller input. Observing this surface never changes the
 * runtime viewport, and failed effects are not retried by the frame loop. */
export function useBrowserViewport(
	surface: RefObject<HTMLDivElement | null>,
	session: BrowserPaneSession,
	view: BrowserPaneView,
	enabled: boolean,
): boolean {
	const [size, setSize] = useState<BrowserViewport>();
	const attempted = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		const element = surface.current;
		if (!element) return;
		const measure = () => {
			const bounds = element.getBoundingClientRect();
			const measured =
				document.visibilityState === "hidden"
					? undefined
					: browserViewport(
							bounds.width,
							bounds.height,
							window.devicePixelRatio,
						);
			setSize((previous) =>
				previous?.width === measured?.width &&
				previous?.height === measured?.height &&
				previous?.scale === measured?.scale
					? previous
					: measured,
			);
		};
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		window.addEventListener("resize", measure);
		document.addEventListener("visibilitychange", measure);
		measure();
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			document.removeEventListener("visibilitychange", measure);
		};
	}, [surface]);
	const control = view.control;
	const holding = Boolean(
		control?.keyboard?.keys.length || control?.pointer?.buttons,
	);
	useEffect(() => {
		const page = view.page;
		const lease = control?.controller;
		if (
			!enabled ||
			!size ||
			!page ||
			!lease ||
			lease.controller_id !== session.controllerId ||
			control.phase !== "ready" ||
			control.requested_controller ||
			control.in_flight ||
			session.read().submitting ||
			holding
		)
			return;
		const signature = JSON.stringify({ page, lease, size });
		if (attempted.current === signature) return;
		attempted.current = signature;
		void session
			.input(
				{
					kind: "environment",
					action: { kind: "viewport", ...size, mobile: false },
				},
				page,
			)
			.catch(() => {});
	}, [enabled, size, view.page, view.submitting, control, holding, session]);
	// Keep the old frame visible, but do not submit a new pointer/text action
	// against its old layout after a resize. Held-contact release stays available.
	return Boolean(
		enabled &&
			size &&
			!holding &&
			view.frame &&
			(Math.abs(view.frame.capture.viewport.width - size.width) >= 1 ||
				Math.abs(view.frame.capture.viewport.height - size.height) >= 1),
	);
}
