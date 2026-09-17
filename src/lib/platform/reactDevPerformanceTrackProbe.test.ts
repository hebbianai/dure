import { describe, expect, it } from "vitest";
import { maskNextReactDevPerformanceTrackProbe } from "./reactDevPerformanceTrackProbe";

describe("maskNextReactDevPerformanceTrackProbe", () => {
	it("hides one capability read and restores the original descriptor", () => {
		const timeStamp = () => {};
		const target = { timeStamp };

		const restore = maskNextReactDevPerformanceTrackProbe(target);

		expect(target.timeStamp).toBeUndefined();
		expect(target.timeStamp).toBe(timeStamp);
		restore();
		expect(target.timeStamp).toBe(timeStamp);
	});

	it("can restore before the capability is read", () => {
		const timeStamp = () => {};
		const target = { timeStamp };

		const restore = maskNextReactDevPerformanceTrackProbe(target);
		restore();

		expect(target.timeStamp).toBe(timeStamp);
	});

	it("reveals an inherited capability without leaving an own property", () => {
		const timeStamp = () => {};
		const target = Object.create({ timeStamp }) as ConsoleWithTimeStamp;

		maskNextReactDevPerformanceTrackProbe(target);

		expect(target.timeStamp).toBeUndefined();
		expect(
			Object.getOwnPropertyDescriptor(target, "timeStamp"),
		).toBeUndefined();
		expect(target.timeStamp).toBe(timeStamp);
	});

	it("leaves a non-configurable capability unchanged", () => {
		const timeStamp = () => {};
		const target = {} as ConsoleWithTimeStamp;
		Object.defineProperty(target, "timeStamp", {
			configurable: false,
			value: timeStamp,
		});

		const restore = maskNextReactDevPerformanceTrackProbe(target);

		expect(target.timeStamp).toBe(timeStamp);
		expect(restore).not.toThrow();
	});
});

type ConsoleWithTimeStamp = Pick<Console, "timeStamp">;
