import { describe, expect, it } from "vitest";
import { presentLifecycleRow } from "@/lib/agents/chat/lifecycleRowPresentation";

describe("presentLifecycleRow", () => {
	it("hides expected transitions", () => {
		expect(presentLifecycleRow("session_ready", null)).toEqual({
			kind: "hidden",
		});
		expect(presentLifecycleRow("turn_completed", null)).toEqual({
			kind: "hidden",
		});
	});

	it("hides a clean session exit entirely", () => {
		expect(
			presentLifecycleRow("session_exited", '{"code":0,"signal":null}'),
		).toEqual({ kind: "hidden" });
		expect(presentLifecycleRow("session_exited", null)).toEqual({
			kind: "hidden",
		});
	});

	it("humanizes abnormal exits instead of leaking raw JSON", () => {
		expect(
			presentLifecycleRow("session_exited", '{"code":1,"signal":null}'),
		).toEqual({ kind: "notice", detail: "exit 1", failed: false });
		expect(
			presentLifecycleRow("session_exited", '{"code":null,"signal":"SIGKILL"}'),
		).toEqual({ kind: "notice", detail: "signal SIGKILL", failed: false });
	});

	it("keeps failures and unknown payloads fully visible", () => {
		expect(presentLifecycleRow("session_failed", "relay crashed")).toEqual({
			kind: "notice",
			detail: "relay crashed",
			failed: true,
		});
		expect(presentLifecycleRow("session_exited", "not json")).toEqual({
			kind: "notice",
			detail: "not json",
			failed: false,
		});
		expect(presentLifecycleRow("some_new_state", "detail")).toEqual({
			kind: "notice",
			detail: "detail",
			failed: false,
		});
	});
});
