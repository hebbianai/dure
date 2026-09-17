let panelMoveQueue: Promise<void> = Promise.resolve();

export function enqueuePaneMove<T>(task: () => Promise<T>): Promise<T> {
	const result = panelMoveQueue.then(task);
	panelMoveQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}
