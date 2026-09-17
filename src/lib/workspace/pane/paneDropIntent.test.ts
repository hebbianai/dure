import { describe, expect, it } from "vitest";
import {
	paneDropIntentLabel,
	resolvePaneDropIntent,
} from "@/lib/workspace/pane/paneDropIntent";

const signals = {
	insideWorkspace: true,
	insideSource: false,
	insertionOrientation: null,
	dockviewPosition: null,
} as const;

describe("resolvePaneDropIntent", () => {
	it("returns no recommendation over the source or outside the workspace", () => {
		expect(resolvePaneDropIntent({ ...signals, insideSource: true })).toBe(
			"none",
		);
		expect(resolvePaneDropIntent({ ...signals, insideWorkspace: false })).toBe(
			"none",
		);
	});

	it("prioritizes insertion, then Dockview split, then floating", () => {
		expect(
			resolvePaneDropIntent({
				...signals,
				insertionOrientation: "HORIZONTAL",
				dockviewPosition: "right",
			}),
		).toBe("insert-column");
		expect(
			resolvePaneDropIntent({ ...signals, dockviewPosition: "bottom" }),
		).toBe("split-bottom");
		expect(resolvePaneDropIntent(signals)).toBe("float");
	});

	it("maps every actionable intent to the label shown by its overlay", () => {
		// Default test language is ko, where t() returns the key itself.
		expect(paneDropIntentLabel("insert-column")).toBe("열로 삽입");
		expect(paneDropIntentLabel("insert-row")).toBe("행으로 삽입");
		expect(paneDropIntentLabel("split-left")).toBe("왼쪽으로 분할");
		expect(paneDropIntentLabel("split-right")).toBe("오른쪽으로 분할");
		expect(paneDropIntentLabel("split-top")).toBe("위로 분할");
		expect(paneDropIntentLabel("split-bottom")).toBe("아래로 분할");
		expect(paneDropIntentLabel("float")).toBe(
			"놓으면 여기에 떠 있는 pane이 됩니다",
		);
		expect(paneDropIntentLabel("none")).toBeNull();
	});
});
