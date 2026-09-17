import { describe, expect, it } from "vitest";
import { WorkspacePaneFocusIntent } from "./workspacePaneFocusIntent";

describe("WorkspacePaneFocusIntent", () => {
	it("measures focus for a pane that already existed", () => {
		const intent = new WorkspacePaneFocusIntent(["file:a"]);

		expect(intent.shouldMeasure("file:a")).toBe(true);
	});

	it("does not supersede a focus sample for a duplicate active-panel event", () => {
		const intent = new WorkspacePaneFocusIntent(["term:a"], "term:before");

		expect(intent.shouldMeasure("term:a")).toBe(true);
		expect(intent.shouldMeasure("term:a")).toBe(false);
	});

	it("does not treat the restored active pane as a new focus", () => {
		const intent = new WorkspacePaneFocusIntent(["term:a"], "term:a");

		expect(intent.shouldMeasure("term:a")).toBe(false);
	});

	it("skips only the first activation caused by opening a pane", () => {
		const intent = new WorkspacePaneFocusIntent(["file:b"], "file:b");
		intent.noteAdded("file:a");

		expect(intent.shouldMeasure("file:a")).toBe(false);
		expect(intent.shouldMeasure("file:b")).toBe(true);
		expect(intent.shouldMeasure("file:a")).toBe(true);
	});

	it("stays correct when activation arrives before the add event", () => {
		const intent = new WorkspacePaneFocusIntent();

		expect(intent.shouldMeasure("file:a")).toBe(false);
		intent.noteAdded("file:a");
		expect(intent.shouldMeasure("file:a")).toBe(false);
	});

	it("treats a removed and re-added pane as a new open", () => {
		const intent = new WorkspacePaneFocusIntent(["file:a"]);
		intent.noteRemoved("file:a");
		intent.noteAdded("file:a");

		expect(intent.shouldMeasure("file:a")).toBe(false);
	});
});
