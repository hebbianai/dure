import type { RemoteHmuxManagedPaneBindingV1 } from "@/lib/terminal/terminalBinding";

const tails = new Map<string, Promise<void>>();

export function remoteManagedAgentLifecycleKey(
	binding: RemoteHmuxManagedPaneBindingV1,
): string {
	return [
		binding.hostId,
		binding.workspaceId,
		binding.sessionId,
		binding.createIdempotencyKey,
		binding.commandBridgeNonce,
	].join("\0");
}

/** Serializes create and presentation-registration cleanup for one exact
 * remote managed identity. The Host remains the destructive runtime authority;
 * this lease only prevents this client from crossing its own async boundaries. */
export async function withRemoteManagedAgentLifecycle<T>(
	binding: RemoteHmuxManagedPaneBindingV1,
	operation: () => Promise<T>,
): Promise<T> {
	const key = remoteManagedAgentLifecycleKey(binding);
	const previous = tails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const turn = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.catch(() => undefined).then(() => turn);
	tails.set(key, tail);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
		if (tails.get(key) === tail) {
			void tail.finally(() => {
				if (tails.get(key) === tail) tails.delete(key);
			});
		}
	}
}
