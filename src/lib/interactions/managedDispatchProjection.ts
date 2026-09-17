export interface ManagedDispatchIdentity {
	taskId: string;
	dispatchId: string;
	generation: number;
}

export function sameManagedDispatchIdentity(
	left: ManagedDispatchIdentity | undefined,
	right: ManagedDispatchIdentity,
): boolean {
	return (
		left?.taskId === right.taskId &&
		left.dispatchId === right.dispatchId &&
		left.generation === right.generation
	);
}
