import { describe, expect, it } from "vitest";
import { selectExactExitedConversation } from "@/lib/sessions/recovery/exitedManagedAgentRecovery";

const conversations = [
	{ id: "newer", title: "newer", mtime: 2 },
	{ id: "older", title: "older", mtime: 1 },
];

describe("exited managed Agent conversation selection", () => {
	it("prefers the durable Agent identity over UI history", () => {
		expect(
			selectExactExitedConversation("stored", "selected", conversations),
		).toBe("stored");
	});

	it("uses an explicit user selection when old Agents lack identity", () => {
		expect(
			selectExactExitedConversation(undefined, "selected", conversations),
		).toBe("selected");
	});

	it("accepts the only cwd-matched conversation without guessing", () => {
		expect(
			selectExactExitedConversation(undefined, null, [conversations[0]]),
		).toBe("newer");
	});

	it("requests explicit selection without turning missing identity into an error", () => {
		expect(
			selectExactExitedConversation(undefined, null, conversations),
		).toBeUndefined();
	});
});
