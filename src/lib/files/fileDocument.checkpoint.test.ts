import { afterEach, expect, it, vi } from "vitest";
import {
	createFileDocument,
	type FileDocumentIO,
} from "@/lib/files/fileDocument";
import { checkpointWindowWork } from "@/lib/persistence/windowWorkCheckpoint";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0)) await dispose();
	vi.useRealTimers();
});

async function openDocument() {
	const drafts = new Map<string, string>();
	const io: FileDocumentIO = {
		read: vi.fn(async () => ({
			path: "/draft.txt",
			name: "draft.txt",
			kind: "text" as const,
			content: "saved",
			size: 5,
			truncated: false,
		})),
		write: vi.fn(async () => 5),
		findCandidates: vi.fn(async () => []),
		readDraft: (key) => drafts.get(key),
		writeDraft: (key, value) => {
			if (value === null) drafts.delete(key);
			else drafts.set(key, value);
		},
		notify: vi.fn(),
	};
	const document = createFileDocument(
		{ source: "local", path: "/draft.txt" },
		io,
	);
	document.attach();
	disposals.push(document.detach);
	await vi.waitFor(() => expect(document.getSnapshot().loading).toBe(false));
	return { drafts, io, document };
}

it("retains a still-mounted unsaved draft before restart without saving it to the user's file", async () => {
	const { drafts, io, document } = await openDocument();
	document.change("unsaved workspace draft");
	const resume = await checkpointWindowWork();
	try {
		expect(drafts.get("local::/draft.txt")).toBe("unsaved workspace draft");
		expect(io.write).not.toHaveBeenCalled();
		expect(document.getSnapshot().draft).toBe("unsaved workspace draft");
	} finally {
		resume();
	}
});

it("waits for an in-flight save and preserves a newer draft while autosave is suspended", async () => {
	const { drafts, io, document } = await openDocument();
	let finish!: (size: number) => void;
	vi.mocked(io.write).mockReturnValueOnce(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	document.change("submitted");
	const saving = document.save();
	await Promise.resolve();
	document.change("newer draft");
	let prepared = false;
	const checkpoint = checkpointWindowWork().then((resume) => {
		prepared = true;
		return resume;
	});
	await Promise.resolve();
	expect(prepared).toBe(false);
	finish(9);
	await saving;
	const resume = await checkpoint;
	try {
		expect(drafts.get("local::/draft.txt")).toBe("newer draft");
		await document.save();
		expect(io.write).toHaveBeenCalledOnce();
	} finally {
		resume();
	}
});

it("does not accept a checkpoint when retaining the draft fails and permits a later retry", async () => {
	const { io, document, drafts } = await openDocument();
	document.change("retained after retry");
	const write = io.writeDraft;
	io.writeDraft = () => {
		throw new Error("storage full");
	};
	await expect(checkpointWindowWork()).rejects.toThrow("storage full");
	io.writeDraft = write;
	const resume = await checkpointWindowWork();
	expect(drafts.get("local::/draft.txt")).toBe("retained after retry");
	resume();
});
