import { expect, it } from "vitest";
import {
	loadHomeViewOptions,
	saveHomeViewOptions,
} from "./homeViewPreferences";

it("uses Space after missing, corrupt, or old preferences without losing a valid selection", () => {
	for (const raw of [null, "broken", "{}", '{"groupBy":"removed"}']) {
		expect(loadHomeViewOptions({ getItem: () => raw }).groupBy).toBe("space");
	}
	let saved = "";
	const value = {
		...loadHomeViewOptions({ getItem: () => null }),
		groupBy: "location" as const,
		visibleFields: [],
	};
	saveHomeViewOptions(value, {
		setItem: (_, text) => {
			saved = text;
		},
	});
	expect(loadHomeViewOptions({ getItem: () => saved })).toEqual(value);
});
