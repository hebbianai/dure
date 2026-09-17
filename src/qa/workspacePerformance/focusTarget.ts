export interface WorkspacePerformanceFocusBackend {
	requestWindowFocus(): Promise<void>;
	hasDocumentFocus(): boolean;
	activatePanel(): void;
	activePanelId(): string | undefined;
	wait(milliseconds: number): Promise<void>;
}

interface WorkspacePerformanceFocusTarget {
	panelId: string;
	timeoutMs?: number;
	retryMs?: number;
}

export interface WorkspacePerformanceDesktopActivationBackend {
	dispatchDesktopActivation(): void;
	activeSpaceId(): string | undefined;
	wait(milliseconds: number): Promise<void>;
}

/**
 * Establish the benchmark's native-window and Dockview focus precondition.
 *
 * Window creation flags are only an intent on macOS. Retrying the real focus
 * request here matches the user path and prevents a background WebView from
 * producing plausible paint samples while never owning terminal input.
 */
export async function focusWorkspacePerformanceTarget(
	target: WorkspacePerformanceFocusTarget,
	backend: WorkspacePerformanceFocusBackend,
): Promise<void> {
	const timeoutMs = target.timeoutMs ?? 5_000;
	const retryMs = target.retryMs ?? 20;
	const deadline = performance.now() + timeoutMs;
	let lastError: unknown;
	while (performance.now() < deadline) {
		try {
			backend.activatePanel();
			await backend.requestWindowFocus();
			if (
				backend.hasDocumentFocus() &&
				backend.activePanelId() === target.panelId
			) {
				return;
			}
		} catch (error) {
			lastError = error;
		}
		await backend.wait(retryMs);
	}
	throw new Error(
		`workspace performance focus precondition failed: documentFocused=${backend.hasDocumentFocus()} activePanel=${backend.activePanelId() ?? "none"} expectedPanel=${target.panelId}${lastError === undefined ? "" : ` lastError=${String(lastError)}`}`,
	);
}

/** A desktop tab action is dispatched once; readiness polling must not click again. */
export async function confirmSingleDesktopActivationIntent(
	desktopId: string,
	backend: WorkspacePerformanceDesktopActivationBackend,
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
	backend.dispatchDesktopActivation();
	const deadline = performance.now() + (options.timeoutMs ?? 5_000);
	while (performance.now() < deadline) {
		if (backend.activeSpaceId() === desktopId) return;
		await backend.wait(options.pollMs ?? 20);
	}
	throw new Error(
		`workspace performance single desktop activation did not select ${desktopId}; active=${backend.activeSpaceId() ?? "none"}`,
	);
}
