import { describe, expect, it } from "vitest";
import { sessionRuntimeDisplayState } from "./sessionRuntimeDisplayState";

const running = {
	lifecycle: "running" as const,
	activity: "waiting" as const,
	attention: "none" as const,
};

describe("sessionRuntimeDisplayState", () => {
	it("is undefined until the Host has observed the session", () => {
		expect(sessionRuntimeDisplayState(undefined)).toBeUndefined();
	});

	it("shows the Host activity while nothing asks for a person", () => {
		expect(sessionRuntimeDisplayState(running)).toBe("waiting");
		expect(
			sessionRuntimeDisplayState({ ...running, activity: "working" }),
		).toBe("working");
	});

	it("shows blocked for every attention kind, over activity", () => {
		for (const attention of [
			"input_required",
			"approval_required",
			"error",
		] as const) {
			expect(
				sessionRuntimeDisplayState({
					...running,
					activity: "working",
					attention,
				}),
			).toBe("blocked");
		}
	});

	it("shows exited once the process is gone, even with stale attention", () => {
		expect(
			sessionRuntimeDisplayState({
				lifecycle: "exited",
				activity: "working",
				attention: "approval_required",
			}),
		).toBe("exited");
	});

	it("keeps a starting session on its activity", () => {
		expect(
			sessionRuntimeDisplayState({ ...running, lifecycle: "starting" }),
		).toBe("waiting");
	});
});
