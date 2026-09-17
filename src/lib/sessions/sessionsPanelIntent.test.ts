import { describe, expect, it } from "vitest";
import {
	setPendingSessionsPanelSearch,
	takePendingSessionsPanelSearch,
} from "@/lib/sessions/sessionsPanelIntent";

describe("sessionsPanelIntent", () => {
	it("인계 검색어는 1회성이다 — 가져가면 비워진다", () => {
		setPendingSessionsPanelSearch("foo");
		expect(takePendingSessionsPanelSearch()).toBe("foo");
		expect(takePendingSessionsPanelSearch()).toBe("");
	});

	it("인계가 없으면 빈 문자열", () => {
		expect(takePendingSessionsPanelSearch()).toBe("");
	});
});
