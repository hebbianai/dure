import { describe, expect, it } from "vitest";
import {
	repositoryDisplayName,
	repositoryNameFromRemote,
} from "@/lib/spaces/repositoryDisplayName";

describe("repositoryNameFromRemote", () => {
	it.each([
		["https://github.com/hebbianai/dure-internal.git", "dure-internal"],
		["git@github.com:hebbianai/dure-internal.git", "dure-internal"],
		["ssh://git@github.com/hebbianai/dure-internal", "dure-internal"],
		["github.com/hebbianai/dure-internal", "dure-internal"],
	])("reads %s as %s", (remote, expected) => {
		expect(repositoryNameFromRemote(remote)).toBe(expected);
	});

	it.each(["", "https://github.com/org/\nother", ".", ".."])(
		"rejects an unusable remote value %j",
		(remote) => {
			expect(repositoryNameFromRemote(remote)).toBeUndefined();
		},
	);
});

describe("repositoryDisplayName", () => {
	it("falls back to the checkout directory when origin has no usable name", () => {
		expect(repositoryDisplayName("/projects/HebbianIDE", "\n")).toBe(
			"HebbianIDE",
		);
	});
});
