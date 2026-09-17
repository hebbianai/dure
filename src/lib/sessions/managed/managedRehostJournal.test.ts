import { describe, expect, it, vi } from "vitest";
import { runManagedRehostJournalOperation } from "@/lib/sessions/managed/managedRehostJournal";

describe("managed rehost journal operation", () => {
	it("returns an existing completion without crossing first admission", async () => {
		const initiate = vi.fn(async () => "initiated");
		await expect(
			runManagedRehostJournalOperation({
				reconcile: async () => "completed",
				initiate,
				isCompleted: () => true,
			}),
		).resolves.toBe("completed");
		expect(initiate).not.toHaveBeenCalled();
	});

	it("recovers a durable completion after response loss", async () => {
		const completion = { outcome: "completed" };
		const reconcile = vi
			.fn<() => Promise<typeof completion | null>>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(completion);
		await expect(
			runManagedRehostJournalOperation({
				reconcile,
				initiate: async () => {
					throw new Error("response lost");
				},
				isCompleted: (value) => value.outcome === "completed",
			}),
		).resolves.toBe(completion);
	});

	it("reconciles a non-completed response and otherwise returns it", async () => {
		const refused = { outcome: "refused" };
		const reconcile = vi
			.fn<() => Promise<typeof refused | null>>()
			.mockResolvedValue(null);
		await expect(
			runManagedRehostJournalOperation({
				reconcile,
				initiate: async () => refused,
				isCompleted: (value) => value.outcome === "completed",
			}),
		).resolves.toBe(refused);
		expect(reconcile).toHaveBeenCalledTimes(2);
	});
});
