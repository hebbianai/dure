import { describe, expect, it } from "vitest";
import {
	notificationClickQaLayout,
	notificationClickQaPlan,
} from "./notificationClickScenario";

describe("notification click signed-app QA scenario", () => {
	it("requires a fresh process only for the cold-start click", () => {
		expect(notificationClickQaPlan("cold-start")).toEqual({
			presentation: "terminating",
			exitBeforeClick: true,
			targetWindow: false,
		});
		expect(notificationClickQaPlan("minimized")).toEqual({
			presentation: "minimized",
			exitBeforeClick: false,
			targetWindow: false,
		});
		expect(notificationClickQaPlan("multi-window")).toEqual({
			presentation: "hidden",
			exitBeforeClick: false,
			targetWindow: true,
		});
		expect(notificationClickQaPlan("owner-change")).toEqual({
			presentation: "hidden",
			exitBeforeClick: false,
			targetWindow: false,
		});
	});

	it("persists the exact current owner panel in a Dockview-compatible layout", () => {
		expect(notificationClickQaLayout("agent:qa")).toEqual({
			panels: { "agent:qa": { params: {} } },
		});
	});
});
