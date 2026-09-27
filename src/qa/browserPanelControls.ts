import { t } from "@/lib/i18n";

/** DOM interactions shared by the native browser-panel probe actions. */
export function createBrowserPanelControls(element: HTMLElement) {
	const waitFor = async (description: string, ready: () => boolean) => {
		const deadline = Date.now() + 25_000;
		while (!ready()) {
			if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
	};
	const input = () =>
		element.querySelector<HTMLTextAreaElement>(
			`textarea[aria-label="${t("panels.browser.pageInput")}"]`,
		);
	const selectTrigger = (key: Parameters<typeof t>[0]) =>
		document.querySelector<HTMLButtonElement>(
			`[role="combobox"][aria-label="${t(key)}"]`,
		);
	const openSelect = async (key: Parameters<typeof t>[0]) => {
		await waitFor("selector ready", () => {
			const trigger = selectTrigger(key);
			return !!trigger && !trigger.disabled;
		});
		selectTrigger(key)!.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
		);
		await waitFor(
			"selector options",
			() => !!document.querySelector('[role="listbox"]'),
		);
		return document.querySelector<HTMLElement>('[role="listbox"]')!;
	};
	const selectOption = (list: HTMLElement, value: string) =>
		[...list.querySelectorAll<HTMLElement>('[role="option"]')].find(
			(option) => option.dataset.value === value,
		);
	const finishSelect = async (
		list: HTMLElement,
		key: "Enter" | "Escape",
		target = list,
	) => {
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
		await waitFor("selector closed", () => !list.isConnected);
	};
	const click = (key: Parameters<typeof t>[0], text = false) => {
		const button = [...element.querySelectorAll("button")].find((node) =>
			text
				? node.textContent === t(key)
				: node.getAttribute("aria-label") === t(key),
		);
		if (!button || button.disabled)
			throw new Error(`Unavailable control: ${key}`);
		button.click();
	};
	const picker = () =>
		element.querySelector<HTMLButtonElement>(
			`button[aria-label="${t("panels.browser.pickElement")}"][aria-describedby]`,
		);
	const transferring = () =>
		element.textContent?.includes(t("panels.browser.controlPending")) === true;
	const preview = () => {
		const surface = picker();
		const rect = surface?.parentElement?.querySelector("svg[viewBox] rect");
		if (!rect) return undefined;
		return {
			x: Number(rect.getAttribute("x")),
			y: Number(rect.getAttribute("y")),
			width: Number(rect.getAttribute("width")),
			height: Number(rect.getAttribute("height")),
			label: surface?.parentElement
				?.querySelector(
					`#${CSS.escape(surface.getAttribute("aria-describedby") ?? "")}`,
				)
				?.querySelector("span")?.textContent,
		};
	};
	return {
		waitFor,
		input,
		selectTrigger,
		openSelect,
		selectOption,
		finishSelect,
		click,
		picker,
		transferring,
		preview,
	};
}
