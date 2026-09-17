import { describe, expect, it } from "vitest";
import {
	onboardingPaneHeaderHidden,
	syncOnboardingPaneHeaders,
} from "@/lib/onboarding/onboardingPaneHeader";

function group(components: string[], hidden = false) {
	return {
		panels: components.map((component, index) => ({
			id: `pane-${index}`,
			api: { component },
		})),
		header: { hidden },
	};
}

describe("onboardingPaneHeaderHidden", () => {
	it("hides the header of a group holding only the guide pane", () => {
		expect(onboardingPaneHeaderHidden(group(["onboarding"]))).toBe(true);
	});

	it("keeps the header for ordinary panes", () => {
		expect(onboardingPaneHeaderHidden(group(["terminal"]))).toBe(false);
		expect(onboardingPaneHeaderHidden(group([]))).toBe(false);
	});

	it("restores the header when the guide shares a group", () => {
		expect(onboardingPaneHeaderHidden(group(["onboarding", "terminal"]))).toBe(
			false,
		);
	});

	it("does not hide controls for different content in an old guide slot", () => {
		const terminal = group(["terminal"]);
		terminal.panels[0].id = "onboarding:main";
		expect(onboardingPaneHeaderHidden(terminal)).toBe(false);
	});
});

describe("syncOnboardingPaneHeaders", () => {
	it("applies the rule across every group", () => {
		const guide = group(["onboarding"]);
		const terminal = group(["terminal"], true);
		syncOnboardingPaneHeaders([guide, terminal]);

		expect(guide.header.hidden).toBe(true);
		expect(terminal.header.hidden).toBe(false);
	});

	it("does not rewrite a header that already matches", () => {
		let writes = 0;
		const guide = {
			panels: [{ id: "pane-guide", api: { component: "onboarding" } }],
			header: {
				get hidden() {
					return true;
				},
				set hidden(_value: boolean) {
					writes += 1;
				},
			},
		};
		syncOnboardingPaneHeaders([guide]);
		expect(writes).toBe(0);
	});
});
