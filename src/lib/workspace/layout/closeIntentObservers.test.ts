import { afterEach, expect, it, vi } from "vitest";
import {
	observeCloseIntent,
	settleCloseIntentObservers,
} from "./closeIntentObservers";
const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});
it("waits for sibling cleanup even when another retirement rejects", async () => {
	let confirm!: () => void;
	const sibling = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				confirm = resolve;
			}),
	);
	disposers.push(
		observeCloseIntent("desktop", () => {
			throw new Error("unconfirmed retirement");
		}),
	);
	disposers.push(observeCloseIntent("desktop", sibling));
	let settled = false;
	const result = settleCloseIntentObservers("desktop").catch((error) => {
		settled = true;
		return error;
	});
	expect(sibling).toHaveBeenCalledOnce();
	await Promise.resolve();
	expect(settled).toBe(false);
	confirm();
	expect(await result).toMatchObject({ message: "unconfirmed retirement" });
});
it("keeps other desktops and disposed resources outside the close barrier", async () => {
	const other = vi.fn(),
		disposed = vi.fn();
	disposers.push(observeCloseIntent("other", other));
	observeCloseIntent("desktop", disposed)();
	await settleCloseIntentObservers("desktop");
	expect(other).not.toHaveBeenCalled();
	expect(disposed).not.toHaveBeenCalled();
});
