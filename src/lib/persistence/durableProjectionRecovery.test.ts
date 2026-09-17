import { describe, expect, it, vi } from "vitest";
import { recoverDurableProjection } from "@/lib/persistence/durableProjectionRecovery";

describe("durable projection recovery", () => {
	it("retries against a frozen ancestor and releases it after convergence", async () => {
		const order: string[] = [];
		const project = vi
			.fn<() => Promise<void>>()
			.mockImplementationOnce(async () => {
				order.push("project");
				throw new Error("first projection failed");
			})
			.mockImplementationOnce(async () => {
				order.push("retry");
			});
		const release = vi.fn();
		const freezeAncestor = vi.fn(() => {
			order.push("freeze");
			return release;
		});
		const reload = vi.fn();

		await expect(
			recoverDurableProjection({ project, freezeAncestor, reload }),
		).resolves.toBe(true);

		expect(project).toHaveBeenCalledTimes(2);
		expect(order).toEqual(["freeze", "project", "retry"]);
		expect(freezeAncestor).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		expect(reload).not.toHaveBeenCalled();
	});

	it("retains the fence and reloads after the retry also fails", async () => {
		const project = vi.fn<() => Promise<void>>().mockRejectedValue(new Error());
		const release = vi.fn();
		const reload = vi.fn();

		await expect(
			recoverDurableProjection({
				project,
				freezeAncestor: () => release,
				reload,
			}),
		).resolves.toBe(false);

		expect(project).toHaveBeenCalledTimes(2);
		expect(release).not.toHaveBeenCalled();
		expect(reload).toHaveBeenCalledOnce();
	});
});
