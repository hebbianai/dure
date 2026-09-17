import { describe, expect, it, vi } from "vitest";
import {
	DURE_NEW_PANE_DRAG_TYPE,
	encodeDureDragPayload,
	isNewPaneDrag,
	readDragTypes,
	readDurePanelDragData,
	stripDureDragPayloadPrefix,
} from "@/lib/platform/productDragPayload";

function dragTypeEvent(type: string, types: () => readonly string[]) {
	return {
		type,
		dataTransfer: {
			get types() {
				return types();
			},
		} as DataTransfer,
	};
}

describe("native drag type snapshots", () => {
	it.each(["dragenter", "dragover"])(
		"reads %s types once for all consumers without reading the payload",
		(type) => {
			const types = vi.fn(() => [DURE_NEW_PANE_DRAG_TYPE, "text/plain"]);
			const event = dragTypeEvent(type, types);
			expect(isNewPaneDrag(event)).toBe(true);
			expect(readDragTypes(event)).toEqual([
				DURE_NEW_PANE_DRAG_TYPE,
				"text/plain",
			]);
			expect(readDragTypes(event).includes("Files")).toBe(false);
			expect(types).toHaveBeenCalledOnce();
		},
	);

	it("does not reuse one event's snapshot for another event sharing its transfer", () => {
		let types = [DURE_NEW_PANE_DRAG_TYPE];
		const getter = vi.fn(() => types);
		const enter = dragTypeEvent("dragenter", getter);
		expect(isNewPaneDrag(enter)).toBe(true);
		types = ["Files"];
		const over = { type: "dragover", dataTransfer: enter.dataTransfer };
		expect(isNewPaneDrag(over)).toBe(false);
		expect(readDragTypes(over)).toEqual(["Files"]);
		expect(getter).toHaveBeenCalledTimes(2);
	});

	it.each(["dragstart", "drop"])("reads fresh types during %s", (type) => {
		let types = [DURE_NEW_PANE_DRAG_TYPE];
		const getter = vi.fn(() => types);
		const event = dragTypeEvent(type, getter);
		expect(isNewPaneDrag(event)).toBe(true);
		types = ["Files"];
		expect(isNewPaneDrag(event)).toBe(false);
		expect(getter).toHaveBeenCalledTimes(2);
	});

	it("copies the hover types instead of retaining a mutable native list", () => {
		const types = [DURE_NEW_PANE_DRAG_TYPE];
		const event = dragTypeEvent("dragover", () => types);
		const snapshot = readDragTypes(event);
		types.push("Files");
		expect(snapshot).toEqual([DURE_NEW_PANE_DRAG_TYPE]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(readDragTypes(event)).toBe(snapshot);
	});

	it("does not infer pane or file capability without a data transfer", () => {
		const event = { type: "dragover", dataTransfer: null };
		expect(readDragTypes(event)).toEqual([]);
		expect(isNewPaneDrag(event)).toBe(false);
	});
});

function transfer(values: Record<string, string>) {
	return {
		getData: (type: string) => values[type] ?? "",
	};
}

describe("Dure drag payload", () => {
	it("writes only the canonical prefix and reads it from text/plain", () => {
		const encoded = encodeDureDragPayload({
			type: "agent",
			agentId: "agent-1",
		});
		expect(encoded).toBe('dure:{"type":"agent","agentId":"agent-1"}');
		expect(readDurePanelDragData(transfer({ "text/plain": encoded }))).toBe(
			encoded,
		);
		expect(stripDureDragPayloadPrefix(encoded)).toBe(
			'{"type":"agent","agentId":"agent-1"}',
		);
	});

	it("accepts the pre-rename prefix and MIME only as fallback input", () => {
		const legacy = 'hebbian:{"type":"agent","agentId":"legacy"}';
		expect(
			readDurePanelDragData(transfer({ "application/hebbian-panel": legacy })),
		).toBe(legacy);
		expect(stripDureDragPayloadPrefix(legacy)).toBe(
			'{"type":"agent","agentId":"legacy"}',
		);
	});

	it("never lets compatibility input override canonical text/plain", () => {
		const canonical = 'dure:{"type":"file","path":"/new"}';
		expect(
			readDurePanelDragData(
				transfer({
					"text/plain": canonical,
					"application/hebbian-panel": 'hebbian:{"type":"file","path":"/old"}',
				}),
			),
		).toBe(canonical);
	});
});
