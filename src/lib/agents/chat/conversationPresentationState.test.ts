import { describe, expect, it, vi } from "vitest";
import {
	conversationActivityAt,
	conversationPrompt,
	conversationTitle,
	conversationPresentationRevision,
	publishConversationMetadata,
	publishConversationTitle,
	subscribeConversationPresentation,
} from "@/lib/agents/chat/conversationPresentationState";

describe("conversationPresentationState", () => {
	it("restores the last readable prompt and clears it on complete snapshots or conversation changes", () => {
		const id = "prompt-reload";
		publishConversationMetadata(id, "thread-1", {
			title: null, activityAt: null,
			recentPrompts: ["Earlier prompt", "Analyze the image", "<task-notification><task-id>one</task-id>"],
		});
		expect(conversationPrompt(id, "thread-1")).toBe("Analyze the image");
		expect(conversationPrompt(id, "thread-2")).toBeUndefined();
		publishConversationMetadata(id, "thread-1", { title: null, activityAt: null, recentPrompts: [] });
		expect(conversationPrompt(id, "thread-1")).toBeUndefined();
	});

	it("replaces exact activity snapshots without inventing time on rename or conversation switch", () => {
		const id = "activity-snapshots";
		const activityAt = "2026-09-03T00:47:09.463Z";
		publishConversationMetadata(id, "thread-1", {
			title: "Before",
			activityAt,
		});
		publishConversationMetadata(id, "thread-1", {
			title: "Renamed",
			activityAt,
		});
		expect(conversationActivityAt(id, "thread-1")).toBe(Date.parse(activityAt));
		expect(conversationActivityAt(id, "thread-2")).toBeUndefined();
		publishConversationMetadata(id, "thread-2", {
			title: null,
			activityAt: null,
		});
		expect(conversationActivityAt(id, "thread-2")).toBeUndefined();
		expect(conversationTitle(id)).toBeUndefined();
		publishConversationMetadata(id, "thread-2", {
			title: null,
			activityAt: "invalid",
		});
		expect(conversationActivityAt(id, "thread-2")).toBeUndefined();
	});

	it("publishes advancing titles and notifies subscribers once per change", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeConversationPresentation(listener);
		const before = conversationPresentationRevision();

		publishConversationTitle("agent-title-1", "Ship steering");
		expect(conversationTitle("agent-title-1")).toBe("Ship steering");
		expect(conversationPresentationRevision()).toBe(before + 1);

		// Re-publishing the same title and observing no title are both no-ops:
		// a page without evidence must never clear a known title.
		publishConversationTitle("agent-title-1", "Ship steering");
		publishConversationTitle("agent-title-1", null);
		expect(conversationTitle("agent-title-1")).toBe("Ship steering");
		expect(listener).toHaveBeenCalledTimes(1);

		publishConversationTitle("agent-title-1", "Converge orphaned turns");
		expect(conversationTitle("agent-title-1")).toBe("Converge orphaned turns");
		expect(listener).toHaveBeenCalledTimes(2);

		unsubscribe();
		publishConversationTitle("agent-title-1", "After unsubscribe");
		expect(listener).toHaveBeenCalledTimes(2);
		expect(conversationTitle(undefined)).toBeUndefined();
	});

	it("normalizes provider decoration before publishing a presentation title", () => {
		publishConversationTitle(
			"agent-title-decoration",
			"✻ Review authentication flow",
		);

		expect(conversationTitle("agent-title-decoration")).toBe(
			"Review authentication flow",
		);
	});
});
