// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
	options: vi.fn(),
	snapshot: vi.fn(),
	report: vi.fn(),
	getItem: vi.fn(),
	setItem: vi.fn(),
}));
vi.mock("@/lib/ipc/core", () => ({ webviewStorageOptions: probe.options }));
vi.mock("@/lib/ipc/windowFocusQa", () => ({
	webviewStorageQaSnapshot: probe.snapshot,
	reportWindowFocusQa: probe.report,
	openWebviewStorageQaNativePeer: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
	WebviewWindow: vi.fn(),
}));
vi.mock("@/lib/qa/qaLog", () => ({ qaLog: vi.fn() }));

const identifier = Array.from({ length: 16 }, (_, index) => index);
beforeEach(() => {
	vi.resetAllMocks();
	vi.resetModules();
	probe.options.mockResolvedValue({ dataStoreIdentifier: identifier });
	probe.snapshot.mockResolvedValue(identifier);
	probe.report.mockResolvedValue(undefined);
	probe.getItem.mockReturnValue(null);
	probe.setItem.mockImplementation((_key, value) => {
		probe.getItem.mockReturnValue(value);
	});
	vi.stubGlobal("localStorage", {
		getItem: probe.getItem,
		setItem: probe.setItem,
	});
});
afterEach(() => vi.unstubAllGlobals());

async function run(phase: string) {
	window.history.replaceState(
		{},
		"",
		`/src/qa/webviewStorage.html?proof=ours&processPhase=${phase}`,
	);
	await import("./webviewStorage");
	await vi.waitFor(() => expect(probe.report).toHaveBeenCalledOnce());
	return probe.report.mock.calls[0][0];
}

it("checks the actual native identity before the first storage access", async () => {
	probe.snapshot.mockResolvedValue(null);
	expect(await run("seed")).toMatchObject({
		result: "failed",
		error: "Native store differs from the explicit fixture store",
	});
	expect(probe.getItem).not.toHaveBeenCalled();
	expect(probe.setItem).not.toHaveBeenCalled();
});

it("does not access a default store when configured options are unavailable", async () => {
	probe.options.mockRejectedValue(new Error("options unavailable"));
	expect(await run("seed")).toMatchObject({
		result: "failed",
		error: "options unavailable",
	});
	expect(probe.snapshot).not.toHaveBeenCalled();
	expect(probe.getItem).not.toHaveBeenCalled();
	expect(probe.setItem).not.toHaveBeenCalled();
});

it("seeds only the selected fresh process store", async () => {
	expect(await run("seed")).toMatchObject({
		result: "passed",
		identifier,
		value: "fixture:ours",
	});
	expect(probe.setItem).toHaveBeenCalledExactlyOnceWith(
		"qa:webview-storage:ours",
		"fixture:ours",
	);
});

it("observes restored data without writing a replacement", async () => {
	probe.getItem.mockReturnValue("fixture:ours");
	expect(await run("restored")).toMatchObject({
		result: "passed",
		value: "fixture:ours",
	});
	expect(probe.setItem).not.toHaveBeenCalled();
});

it("fails missing restart persistence instead of manufacturing passing data", async () => {
	expect(await run("restored")).toMatchObject({
		result: "failed",
		error: "Process storage persistence is incorrect",
	});
	expect(probe.setItem).not.toHaveBeenCalled();
});

it("requires a different store to remain empty", async () => {
	expect(await run("isolated")).toMatchObject({
		result: "passed",
		value: null,
	});
	expect(probe.setItem).not.toHaveBeenCalled();
});

it("rejects an unknown process phase before storage access", async () => {
	expect(await run("unknown")).toMatchObject({
		result: "failed",
		error: "Unknown process phase",
	});
	expect(probe.getItem).not.toHaveBeenCalled();
	expect(probe.setItem).not.toHaveBeenCalled();
});
