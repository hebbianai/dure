import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	acceptRemoteCapture,
	copyPendingCapture,
	dismissDesignModeCapture,
	type PendingCapture,
	sendPendingCapture,
	subscribeDesignModeCapture,
} from "./designModeRuntime";

const mocks = vi.hoisted(() => ({
	deliver: vi.fn(),
	copy: vi.fn(),
	toast: vi.fn(),
}));
vi.mock("@/lib/agents/captureDraftDelivery", () => ({
	deliverCaptureToAgent: mocks.deliver,
}));
vi.mock("@/lib/toast", () => ({ showToast: mocks.toast }));
const captured = {
	label: "button.save",
	path: "main > button",
	selector: "button",
	ancestors: [],
	nearby: [],
	accessibility: {},
	html: "<button>Save</button>",
	htmlElided: false,
	css: {},
	rect: { x: 0, y: 0, width: 20, height: 10 },
	pageRect: { x: 0, y: 0, width: 20, height: 10 },
};
const image = { fileName: "element.png", dataB64: "cG5n" };
let pending: PendingCapture | null;
let stop: () => void;
function deferred() {
	let resolve!: () => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
beforeEach(() => {
	vi.clearAllMocks();
	dismissDesignModeCapture();
	vi.stubGlobal("navigator", { clipboard: { writeText: mocks.copy } });
	mocks.deliver.mockResolvedValue(undefined);
	mocks.copy.mockResolvedValue(undefined);
	stop = subscribeDesignModeCapture((value) => {
		pending = value;
	});
});
afterEach(() => {
	stop();
	dismissDesignModeCapture();
	vi.unstubAllGlobals();
});
it("delivers image bytes only once while the selected capture is pending", async () => {
	const transfer = deferred();
	mocks.deliver.mockReturnValueOnce(transfer.promise);
	acceptRemoteCapture(captured, "send", { attachment: image });
	const sending = sendPendingCapture("agent");
	expect(pending?.sending).toBe(true);
	await sendPendingCapture("agent");
	expect(mocks.deliver).toHaveBeenCalledTimes(1);
	expect(mocks.deliver).toHaveBeenCalledWith(
		"agent",
		expect.stringContaining("<button>Save</button>"),
		[{ kind: "bytes", file: image }],
	);
	transfer.resolve();
	await sending;
	expect(pending).toBeNull();
});
it.each(["success", "failure"])(
	"retains a newer capture after late delivery %s",
	async (outcome) => {
		const transfer = deferred();
		mocks.deliver.mockReturnValueOnce(transfer.promise);
		acceptRemoteCapture(captured);
		const sending = sendPendingCapture("agent");
		acceptRemoteCapture({ ...captured, label: "new" });
		if (outcome === "success") transfer.resolve();
		else transfer.reject(new Error("offline"));
		await sending;
		expect(pending?.captured.label).toBe("new");
		expect(pending?.sending).toBeUndefined();
	},
);
it("retains a failed transfer for explicit retry without repeating it automatically", async () => {
	mocks.deliver.mockRejectedValueOnce(new Error("offline"));
	acceptRemoteCapture(captured, "send", { attachment: image });
	await sendPendingCapture("agent");
	expect(pending?.attachment).toEqual(image);
	expect(pending?.sending).toBe(false);
	expect(mocks.deliver).toHaveBeenCalledTimes(1);
	await sendPendingCapture("agent");
	expect(pending).toBeNull();
});
it("passes an app-owned saved image separately from prompt text", async () => {
	acceptRemoteCapture({
		...captured,
		screenshotPath: "/tmp/local/private.png",
	});
	await sendPendingCapture("remote", "redesign-mockup");
	const [agent, text, files] = mocks.deliver.mock.calls[0];
	expect(agent).toBe("remote");
	expect(text).not.toContain("/tmp/local/private.png");
	expect(files).toEqual([
		{ kind: "local_file", path: "/tmp/local/private.png" },
	]);
});
it("keeps details usable when an image is unavailable", async () => {
	acceptRemoteCapture(captured, "send", { attachmentError: true });
	expect(pending?.attachmentError).toBe(true);
	await sendPendingCapture("agent");
	expect(mocks.deliver).toHaveBeenCalledWith(
		"agent",
		expect.stringContaining("<button>Save</button>"),
		[],
	);
});
it("does not dismiss a newer capture when an older clipboard write finishes", async () => {
	const copying = deferred();
	mocks.copy.mockReturnValueOnce(copying.promise);
	acceptRemoteCapture(captured);
	const copy = copyPendingCapture();
	acceptRemoteCapture({ ...captured, label: "new" });
	copying.resolve();
	await copy;
	expect(pending?.captured.label).toBe("new");
	expect(mocks.copy).toHaveBeenCalledTimes(1);
});
