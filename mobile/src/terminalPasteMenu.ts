import { element } from "./dom";
import { t } from "./i18n";
import "./terminalPasteMenu.css";

/** The hold owns the menu until release, then the native popover owns dismissal. */
export function showTerminalPasteMenu(
	scope: HTMLElement,
	point: { x: number; y: number },
	paste: () => void,
): { dismiss(): void; release(): void } {
	scope.querySelector(".terminal-paste-menu")?.remove();
	const menu = element("div", "terminal-paste-menu");
	// Auto light-dismiss treats the opening finger's pointerup as an outside tap.
	menu.popover = "manual";
	menu.setAttribute("role", "menu");
	menu.setAttribute("aria-label", t("terminal.actions"));
	const viewport = window.visualViewport;
	const top = viewport?.offsetTop ?? 0;
	const button = element(
		"button",
		"terminal-paste-menu__action",
		t("terminal.paste.action"),
	);
	button.type = "button";
	button.setAttribute("role", "menuitem");
	button.addEventListener("pointerdown", (event) => event.preventDefault());
	button.addEventListener("click", () => {
		menu.hidePopover();
		menu.remove();
		paste(); // Clipboard access begins synchronously in this user gesture.
	});
	menu.append(button);
	menu.addEventListener("toggle", (event) => {
		if ((event as ToggleEvent).newState === "closed") menu.remove();
	});
	scope.append(menu);
	menu.showPopover();
	const size = menu.getBoundingClientRect();
	menu.style.left = `${Math.max(12, Math.min(point.x, (viewport?.width ?? innerWidth) - size.width - 12))}px`;
	menu.style.top = `${Math.max(top + 12, Math.min(point.y - size.height - 8, top + (viewport?.height ?? innerHeight) - size.height - 12))}px`;
	return {
		dismiss: () => menu.remove(),
		release: () => {
			if (!menu.isConnected) return;
			menu.popover = "auto";
			menu.showPopover();
		},
	};
}
