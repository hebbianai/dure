import { describe, expect, it } from "vitest";
import {
	popoutWindowLabel,
	presentingWindowLabel,
	SECONDARY_WINDOW_LABEL_PREFIX,
	spaceWindowAccepts,
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

	it("lets a full desktop window present the normal Space it shows", () => {
		const normal = { id: "space-main" };
		const popout = { id: "space-popout", kind: "popout" as const };
		const tornOut = "win-1791187000000-0";

		expect(spaceWindowAccepts(normal, "main")).toBe(true);
		expect(spaceWindowAccepts(normal, tornOut)).toBe(true);
		expect(spaceWindowAccepts(normal, "win-popout-space-main")).toBe(false);
		expect(spaceWindowAccepts(popout, "win-popout-space-popout")).toBe(true);
		expect(spaceWindowAccepts(popout, "main")).toBe(false);
		expect(spaceWindowAccepts(popout, tornOut)).toBe(false);

		expect(presentingWindowLabel(normal, tornOut)).toBe(tornOut);
		expect(presentingWindowLabel(normal, "win-popout-space-x")).toBe("main");
		expect(presentingWindowLabel(popout, "main")).toBe(
			"win-popout-space-popout",
		);
	});

	it("maps every Space kind through the same window authority", () => {
		expect(spaceWindowLabel({ id: "space-main" })).toBe("main");
		expect(spaceWindowLabel({ id: "space-popout", kind: "popout" })).toBe(
			"win-popout-space-popout",
		);
	});
});
