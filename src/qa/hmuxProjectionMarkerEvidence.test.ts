import { describe, expect, test } from "vitest";
import { exactProjectionMarkerEvidence } from "./hmuxProjectionMarkerEvidence";

describe("exactProjectionMarkerEvidence", () => {
	test("publishes only markers present exactly once", () => {
		expect(
			exactProjectionMarkerEvidence({
				missing: 0,
				exact: 1,
				duplicated: 2,
			}),
		).toEqual({ exact: true });
	});
});
