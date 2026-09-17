import { DurableWriteCoordinator } from "@/lib/persistence/durableWriteCoordinator";

const coordinator = new DurableWriteCoordinator();
const LOCK_NAME = "ssh-credential-lifecycle";

export function withSshCredentialLifecycle<T>(
	operation: () => Promise<T> | T,
): Promise<T> {
	return coordinator.run(LOCK_NAME, operation);
}
