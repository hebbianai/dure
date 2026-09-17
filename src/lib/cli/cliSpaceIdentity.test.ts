import { describe, expect, it } from "vitest";

import {
	projectCliSpaceReceipt,
	resolveCliSpaceId,
} from "@/lib/cli/cliSpaceIdentity";

describe("CLI Space identity compatibility", () => {
	it("accepts canonical, deprecated, and equal rolling-upgrade inputs", () => {
		expect(resolveCliSpaceId({ spaceId: " space-a " })).toBe("space-a");
		expect(resolveCliSpaceId({ desktopId: " space-a " })).toBe("space-a");
		expect(
			resolveCliSpaceId({ spaceId: "space-a", desktopId: "space-a" }),
		).toBe("space-a");
	});

	it("rejects conflicting identities and missing required identity", () => {
		expect(() =>
			resolveCliSpaceId({ spaceId: "space-a", desktopId: "space-b" }),
		).toThrow("spaceId and desktopId must identify the same Space");
		expect(() => resolveCliSpaceId({}, { required: true })).toThrow(
			"spaceId is required",
		);
	});

	it("projects nested receipts with one canonical value and an equal alias", () => {
		expect(
			projectCliSpaceReceipt({
				pane: { desktopId: "space-a", panelId: "term:a" },
				source: { spaceId: "space-b", desktopId: "stale" },
				workspaceId: "workspace-runtime",
			}),
		).toEqual({
			pane: {
				spaceId: "space-a",
				desktopId: "space-a",
				panelId: "term:a",
			},
			source: { spaceId: "space-b", desktopId: "space-b" },
			workspaceId: "workspace-runtime",
		});
	});
});
