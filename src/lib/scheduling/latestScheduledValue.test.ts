import { describe, expect, it, vi } from "vitest";
import { LatestScheduledValue } from "./latestScheduledValue";

describe("LatestScheduledValue", () => {
	it("coalesces rapid requests and publishes only the latest value", () => {
		let scheduled: (() => void) | undefined;
		const publish = vi.fn();
		const publisher = new LatestScheduledValue<string>({
			schedule: (task) => {
				scheduled = task;
				return () => {
					scheduled = undefined;
				};
			},
			publish,
		});

		publisher.request("first");
		publisher.request("latest");
		expect(publish).not.toHaveBeenCalled();

		scheduled?.();
		expect(publish).toHaveBeenCalledOnce();
		expect(publish).toHaveBeenCalledWith("latest");
	});

	it("cancels a pending value without retiring the reusable publisher", () => {
		const tasks: Array<() => void> = [];
		const publish = vi.fn();
		const publisher = new LatestScheduledValue<number>({
			schedule: (task) => {
				tasks.push(task);
				return vi.fn();
			},
			publish,
		});

		publisher.request(1);
		publisher.cancel();
		tasks.shift()?.();
		expect(publish).not.toHaveBeenCalled();

		publisher.request(2);
		tasks.shift()?.();
		expect(publish).toHaveBeenCalledWith(2);
	});
});
