import { describe, expect, it } from "vitest";
import {
	popoutWindowLabel,
	SECONDARY_WINDOW_LABEL_PREFIX,
	spaceWindowLabel,
} from "@/lib/workspace/window/windowLabel";

describe("workspace window labels", () => {
	it("derives one valid popout label from the Space identity", () => {
		expect(popoutWindowLabel("space-1")).toBe(
			`${SECONDARY_WINDOW_LABEL_PREFIX}popout-space-1`,
		);
	});

	it("rejects Space identities that cannot address a Tauri window", () => {
		expect(() => popoutWindowLabel("space:1")).toThrow(
			"invalid popout window label",
		);
	});

	it("maps every Space kind through the same window authority", () => {
		expect(spaceWindowLabel({ id: "space-main" })).toBe("main");
		expect(spaceWindowLabel({ id: "space-popout", kind: "popout" })).toBe(
			"win-popout-space-popout",
		);
	});
});
