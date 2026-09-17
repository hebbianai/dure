import { describe, expect, it } from "vitest";
import { parseWindowReportRequest } from "./windowReportCollection";

describe("window report request parsing", () => {
	it("normalizes supported requests", () => {
		expect(
			parseWindowReportRequest({
				requestId: "request-1",
				replyWindowLabel: "main",
				projection: "terminal-input",
			}),
		).toEqual({
			requestId: "request-1",
			replyWindowLabel: "main",
			projection: "terminal-input",
		});
	});

	it.each([
		null,
		{},
		{ requestId: "", replyWindowLabel: "main" },
		{ requestId: "request-1", replyWindowLabel: "" },
		{
			requestId: "request-1",
			replyWindowLabel: "main",
			projection: "unsupported",
		},
	])("rejects malformed request boundaries", (value) => {
		expect(parseWindowReportRequest(value)).toBeUndefined();
	});
});
