import { describe, expect, it, vi } from "vitest";
import { dispatchCliWorktreePresentation } from "./cliWorktreePresentation";

const request = {
	reqId: "export-1",
	action: "worktree.presentation.export",
	params: { sourceChannel: "dev-task-0123456789" },
};
function dependencies() {
	return {
		claim: vi.fn(async () => true),
		complete: vi.fn(async () => undefined),
		isMainWindow: () => true,
		channel: () => request.params.sourceChannel,
		flush: vi.fn(async () => undefined),
		export: vi.fn(async () => '{"version":8,"state":{}}'),
	};
}

describe("claimed worktree presentation export", () => {
	it("waits for existing writes before returning the exact source snapshot", async () => {
		const deps = dependencies();
		deps.export.mockImplementation(async () => {
			expect(deps.flush).toHaveBeenCalledOnce();
			return "exact source bytes";
		});
		expect(await dispatchCliWorktreePresentation(request, deps)).toBe(true);
		expect(deps.complete).toHaveBeenCalledWith(
			request.reqId,
			{
				ok: true,
				schemaVersion: 1,
				sourceChannel: request.params.sourceChannel,
				serializedValue: "exact source bytes",
			},
			request.action,
		);
	});

	it("leaves unrelated requests and unclaimed or secondary-window deliveries alone", async () => {
		const deps = dependencies();
		expect(
			await dispatchCliWorktreePresentation(
				{ ...request, action: "settings.get" },
				deps,
			),
		).toBe(false);
		expect(deps.claim).not.toHaveBeenCalled();
		await dispatchCliWorktreePresentation(request, {
			...deps,
			isMainWindow: () => false,
		});
		expect(deps.claim).not.toHaveBeenCalled();
		deps.claim.mockResolvedValue(false);
		await dispatchCliWorktreePresentation(request, deps);
		expect(deps.export).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
	});

	it("refuses the stable channel and a different dev channel before reading", async () => {
		for (const channel of ["stable", "dev-other-9876543210"]) {
			const deps = dependencies();
			await dispatchCliWorktreePresentation(request, {
				...deps,
				channel: () => channel,
			});
			expect(deps.flush).not.toHaveBeenCalled();
			expect(deps.export).not.toHaveBeenCalled();
			expect(deps.complete).toHaveBeenCalledWith(
				request.reqId,
				expect.objectContaining({ ok: false }),
				request.action,
			);
		}
	});

	it("does not export an older value while a durable write is known to have failed", async () => {
		const deps = dependencies();
		deps.flush.mockRejectedValue(new Error("durable write failed"));
		await dispatchCliWorktreePresentation(request, deps);
		expect(deps.export).not.toHaveBeenCalled();
		expect(deps.complete).toHaveBeenCalledWith(
			request.reqId,
			expect.objectContaining({ ok: false }),
			request.action,
		);
	});
});
