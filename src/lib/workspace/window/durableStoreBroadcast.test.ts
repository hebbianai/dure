import { describe, expect, it, vi } from "vitest";

import {
	publishDurableStoreChanged,
	subscribeDurableStoreChanged,
	type DurableStoreBroadcastBackend,
} from "@/lib/workspace/window/durableStoreBroadcast";

function transport(label: string) {
	const listeners: ((payload: unknown) => void)[] = [];
	const emitted: unknown[] = [];
	const unlisten = vi.fn();
	const backend: DurableStoreBroadcastBackend = {
		emitChanged: async (payload) => {
			emitted.push(payload);
			for (const listener of [...listeners]) listener(payload);
		},
		listenChanged: async (listener) => {
			listeners.push(listener);
			return unlisten;
		},
		currentWindowLabel: () => label,
	};
	return { backend, emitted, unlisten };
}

describe("durableStoreBroadcast", () => {
	it("names the completed store write and its source", async () => {
		const main = transport("main");

		await publishDurableStoreChanged("agent-ide", main.backend);

		expect(main.emitted).toEqual([
			{ source: "main", store: "agent-ide" },
		]);
	});

	it("subscribes before its initial read and then receives peer commits", async () => {
		const popout = transport("popout");
		const onChanged = vi.fn();
		subscribeDurableStoreChanged("agent-ide", onChanged, popout.backend);
		await Promise.resolve();

		expect(onChanged).toHaveBeenCalledOnce();
		await popout.backend.emitChanged({ source: "main", store: "agent-ide" });
		expect(onChanged).toHaveBeenCalledTimes(2);
	});

	it("ignores its own write and unrelated stores", async () => {
		const main = transport("main");
		const onChanged = vi.fn();
		subscribeDurableStoreChanged("agent-ide", onChanged, main.backend);
		await Promise.resolve();
		onChanged.mockClear();

		await publishDurableStoreChanged("agent-ide", main.backend);
		await main.backend.emitChanged({ source: "peer", store: "other" });

		expect(onChanged).not.toHaveBeenCalled();
	});

	it("stops listening when disposed", async () => {
		const popout = transport("popout");
		const stop = subscribeDurableStoreChanged(
			"agent-ide",
			vi.fn(),
			popout.backend,
		);
		await Promise.resolve();

		stop();

		expect(popout.unlisten).toHaveBeenCalledOnce();
	});
});
