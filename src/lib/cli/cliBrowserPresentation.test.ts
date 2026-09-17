import { expect, it, vi } from "vitest";
import { handleCliBrowserPresentation } from "./cliBrowserPresentation";

const resource = {
	resource_id: "browser:one",
	generation: "generation:one",
	workspace_id: "workspace:one",
};
const request = {
	kind: "present",
	schemaVersion: 1,
	backendProfileId: "local",
	backend: { id: "backend:one", generation: "generation:one" },
	resource,
	pageId: "page:one",
	spaceId: "space:one",
	windowLabel: "popout_one",
};
function fixture(label = "popout_one") {
	return {
		windowLabel: () => label,
		claim: vi.fn(async () => true),
		present: vi.fn(async () => ({
			state: "requested" as const,
			spaceId: "space:one",
			windowLabel: label,
			resource,
			pageId: "page:one",
			panelId: "browser:one",
		})),
	};
}
it("only the selected window claims and presents an exact request", async () => {
	const runtime = fixture();
	expect(
		await handleCliBrowserPresentation(request, "req:one", runtime),
	).toMatchObject({ ok: true, presentation: { pageId: "page:one" } });
	expect(runtime.claim).toHaveBeenCalledExactlyOnceWith("req:one");
	expect(runtime.present).toHaveBeenCalledExactlyOnceWith(request);
	const peer = fixture("main");
	expect(
		await handleCliBrowserPresentation(request, "req:one", peer),
	).toBeNull();
	expect(peer.claim).not.toHaveBeenCalled();
	expect(peer.present).not.toHaveBeenCalled();
});
it("a losing claim never invokes the presentation transaction", async () => {
	const runtime = fixture();
	runtime.claim.mockResolvedValue(false);
	expect(
		await handleCliBrowserPresentation(request, "req:one", runtime),
	).toBeNull();
	expect(runtime.present).not.toHaveBeenCalled();
});
it("main claims malformed requests once to return a typed refusal; peers stay silent", async () => {
	const main = fixture("main");
	expect(
		await handleCliBrowserPresentation(
			{ ...request, token: "unexpected" },
			"req:bad",
			main,
		),
	).toMatchObject({
		ok: false,
		error: { code: "browser_presentation_invalid" },
	});
	expect(main.claim).toHaveBeenCalledOnce();
	expect(main.present).not.toHaveBeenCalled();
	const peer = fixture();
	expect(await handleCliBrowserPresentation({}, "req:bad", peer)).toBeNull();
	expect(peer.claim).not.toHaveBeenCalled();
});
it("a claimed transaction failure preserves its typed code without claiming again", async () => {
	const runtime = fixture();
	runtime.present.mockRejectedValue(
		Object.assign(new Error("Space moved"), {
			code: "browser_presentation_window_changed",
		}),
	);
	expect(
		await handleCliBrowserPresentation(request, "req:one", runtime),
	).toEqual({
		ok: false,
		error: {
			code: "browser_presentation_window_changed",
			message: "Space moved",
		},
	});
	expect(runtime.claim).toHaveBeenCalledOnce();
});
it("a failed claim transport is not retried or treated as permission to present", async () => {
	const runtime = fixture("main");
	runtime.claim.mockRejectedValue(new Error("disconnected"));
	await expect(
		handleCliBrowserPresentation(
			{ ...request, windowLabel: "main" },
			"req:one",
			runtime,
		),
	).rejects.toThrow("disconnected");
	expect(runtime.claim).toHaveBeenCalledOnce();
	expect(runtime.present).not.toHaveBeenCalled();
});
