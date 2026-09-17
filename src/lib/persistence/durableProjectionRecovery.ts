export interface DurableProjectionRecoveryOptions {
	readonly project: () => Promise<void>;
	readonly freezeAncestor?: () => () => void;
	readonly reload?: () => void;
	readonly onRetry?: (error: unknown) => void;
	readonly onFailure?: (error: unknown) => void;
	readonly onReloadFailure?: (error: unknown) => void;
}

/** Retry one projection while retaining its pre-projection durable ancestor. */
export async function recoverDurableProjection(
	options: DurableProjectionRecoveryOptions,
): Promise<boolean> {
	const releaseAncestor = options.freezeAncestor?.();
	try {
		await options.project();
		releaseAncestor?.();
		return true;
	} catch (error) {
		options.onRetry?.(error);
	}

	try {
		await options.project();
		releaseAncestor?.();
		return true;
	} catch (error) {
		options.onFailure?.(error);
	}

	try {
		if (options.reload) {
			try {
				options.reload();
			} catch (error) {
				options.onReloadFailure?.(error);
			}
		}
	} finally {
		// A successful navigation discards this realm before the next task. If
		// reload throws or is ignored, the surviving realm must not retain a stale
		// projection ancestor forever.
		if (releaseAncestor) setTimeout(releaseAncestor, 0);
	}
	return false;
}
