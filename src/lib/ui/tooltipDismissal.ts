/** Watch only an engaged tooltip, including its pending hover delay. */
export function watchTooltipDismissal(
	trigger: HTMLElement,
	dismiss: () => void,
) {
	const doc = trigger.ownerDocument;
	const view = doc.defaultView;
	const visibility = () => {
		if (doc.hidden) dismiss();
	};
	const leaveDocument = (event: PointerEvent) => {
		if (event.relatedTarget === null) dismiss();
	};
	const keyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") dismiss();
	};
	const scroll = (event: Event) => {
		const target = event.target as Node | null;
		if (target?.contains?.(trigger)) dismiss();
	};
	view?.addEventListener("blur", dismiss);
	doc.addEventListener("visibilitychange", visibility);
	doc.addEventListener("pointerdown", dismiss, true);
	doc.addEventListener("pointercancel", dismiss, true);
	doc.addEventListener("dragstart", dismiss, true);
	doc.addEventListener("pointerout", leaveDocument, true);
	doc.addEventListener("keydown", keyDown, true);
	doc.addEventListener("scroll", scroll, true);
	return () => {
		view?.removeEventListener("blur", dismiss);
		doc.removeEventListener("visibilitychange", visibility);
		doc.removeEventListener("pointerdown", dismiss, true);
		doc.removeEventListener("pointercancel", dismiss, true);
		doc.removeEventListener("dragstart", dismiss, true);
		doc.removeEventListener("pointerout", leaveDocument, true);
		doc.removeEventListener("keydown", keyDown, true);
		doc.removeEventListener("scroll", scroll, true);
	};
}
