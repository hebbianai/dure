import { describe, expect, it, vi } from "vitest";
import { withRemoteManagedAgentLifecycle } from "@/lib/sessions/launch/remoteManagedAgentLifecycle";
import { remoteHmuxManagedBinding } from "@/lib/terminal/terminalBinding";

describe("remote managed Agent lifecycle lease", () => {
	it("serializes the same exact registration but not a different generation key", async () => {
		const binding = remoteHmuxManagedBinding(
			"session-1",
			"workspace-1",
			"host-1",
			"bridge-1",
			"create-1",
		);
		const events: string[] = [];
		let release!: () => void;
		const first = withRemoteManagedAgentLifecycle(binding, async () => {
			events.push("first:start");
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			events.push("first:end");
		});
		const second = withRemoteManagedAgentLifecycle(binding, async () => {
			events.push("second:start");
		});
		const other = withRemoteManagedAgentLifecycle(
			{ ...binding, createIdempotencyKey: "create-2" },
			async () => {
				events.push("other:start");
			},
		);

		await vi.waitFor(() => {
			expect(events).toEqual(["first:start", "other:start"]);
		});
		release();
		await Promise.all([first, second, other]);
		expect(events).toEqual([
			"first:start",
			"other:start",
			"first:end",
			"second:start",
		]);
	});
});
