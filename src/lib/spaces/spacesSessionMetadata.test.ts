import { describe, expect, it } from "vitest";
import { hmuxSessionSummaryFixture } from "@/test/agentFixtures";
import { createSpacesSessionMetadataSelector } from "./spacesSessionMetadata";

describe("Spaces session metadata projection", () => {
	it("retains exact keys even when names and builds are unavailable", () => {
		const select = createSpacesSessionMetadataSelector();
		const entry = hmuxSessionSummaryFixture({ sessionName: undefined });
		const first = select({ hmuxSessionMetadata: { first: entry } });
		const replaced = select({ hmuxSessionMetadata: { second: entry } });
		expect(replaced).not.toBe(first);
		expect(Object.keys(replaced.sessionNameByMetadataKey)).toEqual(["second"]);
		expect(Object.keys(replaced.hostBuildByMetadataKey)).toEqual(["second"]);
		expect(first.sessionNameByMetadataKey).toEqual({ first: undefined });
	});

	it("advances its source after output-only updates and isolates subscribers", () => {
		const select = createSpacesSessionMetadataSelector();
		const other = createSpacesSessionMetadataSelector();
		const first = { hmuxSessionMetadata: { one: hmuxSessionSummaryFixture() } };
		const projection = select(first);
		let scans = 0;
		const next = {
			hmuxSessionMetadata: new Proxy(
				{
					one: { ...first.hmuxSessionMetadata.one, outputSeq: "2" },
				},
				{
					ownKeys(target) {
						scans += 1;
						return Reflect.ownKeys(target);
					},
				},
			),
		};
		expect(select(next)).toBe(projection);
		expect(scans).toBe(1);
		expect(select(next)).toBe(projection);
		expect(scans).toBe(1);
		expect(other({ hmuxSessionMetadata: {} }).sessionNameByMetadataKey).toEqual(
			{},
		);
		expect(select(first)).toBe(projection);
		expect(select(next)).toBe(projection);
		expect(projection.sessionNameByMetadataKey).toEqual({ one: "session-1" });
	});
});
