// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	readRememberedFeedbackContact,
	rememberFeedbackContact,
} from "@/lib/feedback/feedbackContact";

afterEach(() => {
	window.localStorage.clear();
});

describe("feedbackContact", () => {
	it("defaults to empty when nothing was remembered", () => {
		expect(readRememberedFeedbackContact()).toBe("");
	});

	it("remembers the last value written", () => {
		rememberFeedbackContact("first@example.com");
		rememberFeedbackContact("second@example.com");
		expect(readRememberedFeedbackContact()).toBe("second@example.com");
	});

	it("swallows storage failures without throwing", () => {
		const real = Object.getOwnPropertyDescriptor(window, "localStorage");
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			get() {
				throw new Error("SecurityError");
			},
		});
		try {
			expect(() => rememberFeedbackContact("a@example.com")).not.toThrow();
			expect(readRememberedFeedbackContact()).toBe("");
		} finally {
			if (real) Object.defineProperty(window, "localStorage", real);
		}
	});
});
