export class WorkspacePerformanceCleanupError extends Error {
	readonly primaryError: unknown;
	readonly cleanupError: unknown;

	constructor(message: string, primaryError: unknown, cleanupError: unknown) {
		super(message);
		this.name = "WorkspacePerformanceCleanupError";
		this.primaryError = primaryError;
		this.cleanupError = cleanupError;
	}
}
