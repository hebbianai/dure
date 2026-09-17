import { describe, expect, it } from "vitest";
import {
	managedBuildRehostPreview,
	sameManagedBuildRehostPreview,
} from "@/lib/sessions/managed/managedBuildRehostPreview";

describe("managed build rehost preview", () => {
	it("records the honest legacy first-hop boundary", () => {
		const preview = managedBuildRehostPreview({
			location: "ssh",
			providerId: "codex",
			conversationId: " conversation-1 ",
			sourceGeneration: " generation-1 ",
			sourceBuildId: " build-old ",
			targetBuildId: " build-current ",
		});
		expect(preview).toEqual({
			schemaVersion: 1,
			location: "ssh",
			providerId: "codex",
			conversationId: "conversation-1",
			sourceGeneration: "generation-1",
			sourceBuildId: "build-old",
			targetBuildId: "build-current",
			attachmentSafety: "initiating_dure_pane_only",
		});
		expect(sameManagedBuildRehostPreview(preview, { ...preview })).toBe(true);
	});

	it("permits an exact same-build SSH replacement", () => {
		expect(
			managedBuildRehostPreview({
				location: "ssh",
				providerId: "codex",
				conversationId: "conversation-1",
				sourceGeneration: "generation-1",
				sourceBuildId: "build-current",
				targetBuildId: "build-current",
			}),
		).toMatchObject({
			sourceBuildId: "build-current",
			targetBuildId: "build-current",
		});
	});

	it.each([
		["missing source", { sourceBuildId: undefined }],
		["missing target", { targetBuildId: undefined }],
		["missing conversation", { conversationId: " " }],
		["missing source generation", { sourceGeneration: undefined }],
		["already current", { sourceBuildId: "same", targetBuildId: "same" }],
	])("refuses %s without manufacturing upgrade authority", (_name, patch) => {
		expect(() =>
			managedBuildRehostPreview({
				location: "local",
				providerId: "claude",
				conversationId: "conversation-1",
				sourceGeneration: "generation-1",
				sourceBuildId: "build-old",
				targetBuildId: "build-current",
				...patch,
			}),
		).toThrow();
	});
});
