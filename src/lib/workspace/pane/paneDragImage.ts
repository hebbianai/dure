export interface PaneDragImageOptions {
	title: string;
	count?: number;
}

/** Use the compact pane-chrome ghost instead of a native full-row snapshot.
 * WebKit captures reliably only while the element is attached to document. */
export function setPaneDragImage(
	dataTransfer: DataTransfer,
	options: PaneDragImageOptions,
): void {
	if (typeof dataTransfer.setDragImage !== "function") return;
	const ghost = document.createElement("div");
	ghost.className = "pane-transfer-drag-image";
	ghost.setAttribute("aria-hidden", "true");

	const grip = document.createElement("span");
	grip.className = "pane-transfer-drag-image-grip";
	grip.textContent = "⠿";
	ghost.appendChild(grip);

	const title = document.createElement("span");
	title.className = "pane-transfer-drag-image-title";
	title.textContent = options.title;
	ghost.appendChild(title);

	if ((options.count ?? 1) > 1) {
		const count = document.createElement("span");
		count.className = "pane-transfer-drag-image-count";
		count.textContent = String(options.count);
		ghost.appendChild(count);
	}

	document.body.appendChild(ghost);
	dataTransfer.setDragImage(ghost, 24, 18);
	setTimeout(() => ghost.remove(), 0);
}
