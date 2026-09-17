import { describe, expect, it } from "vitest";
import {
	DISCOVERY_EXPANDED_LIMIT,
	DISCOVERY_PREVIEW_LIMIT,
	visibleDiscoveryItems,
} from "@/lib/spaces/discoveryList";

describe("bounded discovery lists", () => {
	const items = Array.from(
		{ length: DISCOVERY_EXPANDED_LIMIT + 10 },
		(_, index) => index,
	);

	it("shows a small preview before explicit expansion", () => {
		expect(visibleDiscoveryItems(items, false)).toEqual(
			items.slice(0, DISCOVERY_PREVIEW_LIMIT),
		);
	});

	it("keeps explicitly expanded discovery censuses bounded", () => {
		expect(visibleDiscoveryItems(items, true)).toEqual(
			items.slice(0, DISCOVERY_EXPANDED_LIMIT),
		);
	});
});
