/** A render replaces DOM nodes, so restore the new scroll owner by identity. */
export function preserveHomeScroll(
	root: HTMLElement,
	render: () => void,
): void {
	const top = root.querySelector(".home__body")?.scrollTop ?? 0;
	const left = root.querySelector(".tabs")?.scrollLeft ?? 0;
	const group = root.querySelector<HTMLElement>(".home")?.dataset.group;
	const menu = root.querySelector(".home-menu");
	const focused =
		document.activeElement instanceof HTMLElement &&
		root.contains(document.activeElement)
			? document.activeElement
			: undefined;
	render();
	const nextMenu = root.querySelector(".home-menu");
	if (nextMenu) {
		const buttons = [...nextMenu.querySelectorAll<HTMLButtonElement>("button")];
		const replacement = buttons.find(
			(button) =>
				button.getAttribute("aria-label") ===
					focused?.getAttribute("aria-label") &&
				button.textContent === focused?.textContent,
		);
		(replacement ?? buttons[0])?.focus({ preventScroll: true });
	} else if (menu)
		root
			.querySelector<HTMLButtonElement>(".home__view-options")
			?.focus({ preventScroll: true });
	else if (
		focused &&
		group &&
		root.querySelector<HTMLElement>(".home")?.dataset.group === group
	) {
		// Census insertion must preserve focus by session identity, not row index.
		const sessionId = focused.dataset.sessionId;
		const replacement = [
			...root.querySelectorAll<HTMLButtonElement>("button"),
		].find((button) =>
			sessionId
				? button.dataset.sessionId === sessionId
				: button.className === focused.className &&
					button.textContent === focused.textContent &&
					button.getAttribute("aria-label") ===
						focused.getAttribute("aria-label"),
		);
		replacement?.focus({ preventScroll: true });
	}
	const body = root.querySelector(".home__body");
	const tabs = root.querySelector(".tabs");
	if (body && root.querySelector<HTMLElement>(".home")?.dataset.group === group)
		body.scrollTop = top;
	if (tabs) tabs.scrollLeft = left;
}
