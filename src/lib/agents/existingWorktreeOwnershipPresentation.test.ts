import { afterEach, describe, expect, it } from "vitest";
import { existingWorktreeOwnershipGuidance } from "@/lib/agents/existingWorktreeOwnershipPresentation";
import { setLang } from "@/lib/i18n";

afterEach(() => setLang("ko"));

describe("existingWorktreeOwnershipGuidance", () => {
	it("presents multiple owners as reviewable information", () => {
		setLang("en");
		expect(
			existingWorktreeOwnershipGuidance({
				state: "ambiguous",
				owners: [
					{
						agentId: "one",
						provider: "codex",
						channel: "dev-one",
						runtimeLiveness: "live",
						paneLiveness: "live",
					},
					{
						agentId: "two",
						provider: "claude",
						channel: "dev-two",
						runtimeLiveness: "live",
						paneLiveness: "live",
					},
				],
			}),
		).toBe("Ownership needs review");
	});

	it("presents a live owner without telling the user to end it", () => {
		setLang("en");
		expect(
			existingWorktreeOwnershipGuidance({
				state: "live_owned",
				claimReceiptId: "receipt-one",
				owners: [
					{
						agentId: "agent-one",
						provider: "codex",
						channel: "dev-one",
						runtimeLiveness: "live",
						paneLiveness: "live",
					},
				],
			}),
		).toBe("In use · codex");
	});
});
