// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { track } from "@/lib/ipc/telemetry";
import { useStore } from "@/store";

vi.mock("@/lib/ipc/telemetry", () => ({ track: vi.fn() }));

afterEach(() => {
	vi.mocked(track).mockClear();
});

describe("addSpace", () => {
	it("offers space_created for a person's Space, not for popout staging", () => {
		const created = useStore.getState().addSpace({ name: "Telemetry QA" });
		expect(vi.mocked(track).mock.calls).toEqual([["space_created"]]);
		useStore
			.getState()
			.addSpace({ kind: "popout", originSpaceId: created, activate: false });
		expect(vi.mocked(track)).toHaveBeenCalledTimes(1);
	});
});
