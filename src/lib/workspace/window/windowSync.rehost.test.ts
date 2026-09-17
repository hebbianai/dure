// @vitest-environment jsdom

import type { EventCallback } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TauriCoreModule } from "@/lib/ipc/core";

const native = vi.hoisted(() => ({
	listeners: new Map<string, Set<EventCallback<unknown>>>(),
	invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<TauriCoreModule>()),
	invoke: native.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (event: string, handler: EventCallback<unknown>) => {
		const handlers = native.listeners.get(event) ?? new Set();
		handlers.add(handler);
		native.listeners.set(event, handlers);
		return () => handlers.delete(handler);
	},
	emit: async (event: string, payload: unknown) => {
		for (const handler of native.listeners.get(event) ?? []) {
			handler({ event, payload, id: 1 });
		}
	},
	emitTo: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", async (original) => ({
	...(await original<typeof import("@tauri-apps/api/window")>()),
	getCurrentWindow: () => ({ label: "win-peer" }),
}));
vi.mock("@tauri-apps/api/webviewWindow", async (original) => ({
	...(await original<typeof import("@tauri-apps/api/webviewWindow")>()),
	getCurrentWebviewWindow: () => ({ label: "win-peer" }),
}));

import { emit } from "@tauri-apps/api/event";
import { startCliServerObservers } from "@/lib/cli/cliServerObservers";
import { DURABLE_STORE_REHYDRATED_EVENT } from "@/lib/persistence/durableStoreRehydration";
import {
	MANAGED_AGENT_REHOSTED_EVENT,
	parseManagedAgentRehostSyncPayload,
} from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import { startWindowSync } from "@/lib/workspace/window/windows";
import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";
import {
	managedRehostAgentFixture as agent,
	managedRehostNotificationFixture as notification,
} from "@/test/managedRehostFixtures";

const stops: Array<() => void> = [];
const rehydrated = vi.fn();
let stopWindowSync: () => void;

beforeEach(async () => {
	Reflect.deleteProperty(globalThis, "__dureTauriWebviewEventAuthorityV1");
	native.listeners.clear();
	native.invoke.mockReset();
	rehydrated.mockClear();
	window.addEventListener(DURABLE_STORE_REHYDRATED_EVENT, rehydrated);
	useStore.setState({
		projects: [
			{
				id: "project-1",
				name: "Project",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [agent(0)],
		layouts: {},
		fileDrafts: { "local:local:/repo/draft.ts": "unsaved work" },
		activeSpaceId: "window-local-space",
	});
	await durableAppStorage.flush();
	stopWindowSync = startWindowSync();
	stops.push(() => stopWindowSync(), await startCliServerObservers());
	await vi.waitFor(() => expect(rehydrated).toHaveBeenCalled());
	await durableAppStorage.flush();
});

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	await durableAppStorage.flush();
	window.removeEventListener(DURABLE_STORE_REHYDRATED_EVENT, rehydrated);
});

async function commitFromPeer(generation: number) {
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => {
		if (!current) throw new Error("test store is missing");
		return {
			value: {
				...current,
				state: { ...current.state, agents: [agent(generation)] },
			},
			result: undefined,
		};
	});
}

function durableAgent() {
	return JSON.parse(localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null")
		.state.agents[0];
}

async function notifyAndRehydrate(event: string, payload: unknown) {
	const before = rehydrated.mock.calls.length;
	await emit(event, payload);
	await vi.waitFor(() =>
		expect(rehydrated.mock.calls.length).toBeGreaterThan(before),
	);
	await durableAppStorage.flush();
}

describe("managed rehost window synchronization", () => {
	it("does not roll the current Agent or storage back when an older notification arrives", async () => {
		useStore.setState({ agents: [agent(2)] });
		await durableAppStorage.flush();
		const delayed = notification(1);
		expect(parseManagedAgentRehostSyncPayload(delayed)).toBeDefined();

		await notifyAndRehydrate(MANAGED_AGENT_REHOSTED_EVENT, delayed);

		expect(useStore.getState().agents[0]).toEqual(agent(2));
		expect(durableAgent()).toEqual(agent(2));
		expect(native.invoke).not.toHaveBeenCalled();
	});

	it("recovers a stale window from the current committed store, not the delayed payload", async () => {
		await commitFromPeer(2);
		expect(useStore.getState().agents[0].sessionId).toBe("session-0");

		await notifyAndRehydrate(MANAGED_AGENT_REHOSTED_EVENT, notification(1));
		expect(useStore.getState().agents[0]).toEqual(agent(2));
		expect(durableAgent()).toEqual(agent(2));
		expect(useStore.getState().fileDrafts).toEqual({
			"local:local:/repo/draft.ts": "unsaved work",
		});
		expect(useStore.getState().activeSpaceId).toBe("window-local-space");
		expect(native.invoke).not.toHaveBeenCalled();
	});

	it("converges after duplicate and reversed notifications without recreating a deleted Agent", async () => {
		await commitFromPeer(3);
		for (const generation of [3, 3, 1, 2, 1]) {
			await notifyAndRehydrate(
				MANAGED_AGENT_REHOSTED_EVENT,
				notification(generation),
			);
			expect(useStore.getState().agents[0]).toEqual(agent(3));
			expect(durableAgent()).toEqual(agent(3));
		}
		useStore.setState({ agents: [] });
		await durableAppStorage.flush();
		await notifyAndRehydrate(MANAGED_AGENT_REHOSTED_EVENT, notification(3));
		expect(useStore.getState().agents).toEqual([]);
		expect(durableAgent()).toBeUndefined();
		expect(native.invoke).not.toHaveBeenCalled();
	});

	it("waits for the durable commit when a notification arrives before persistence", async () => {
		await notifyAndRehydrate(MANAGED_AGENT_REHOSTED_EVENT, notification(1));
		expect(useStore.getState().agents[0]).toEqual(agent(0));
		expect(durableAgent()).toEqual(agent(0));

		await commitFromPeer(1);
		await notifyAndRehydrate("dure://persistence/store-changed", {
			source: "win-source",
			store: DURABLE_APP_STORE_NAME,
		});
		expect(useStore.getState().agents[0]).toEqual(agent(1));
		expect(durableAgent()).toEqual(agent(1));
	});

	it("recovers a lost rehost notification through the existing durable invalidation", async () => {
		await commitFromPeer(2);
		await notifyAndRehydrate("dure://persistence/store-changed", {
			source: "win-source",
			store: DURABLE_APP_STORE_NAME,
		});
		expect(useStore.getState().agents[0]).toEqual(agent(2));
		expect(durableAgent()).toEqual(agent(2));
	});

	it("ignores notifications after disposal and reads current state when the window restarts", async () => {
		stopWindowSync();
		await commitFromPeer(2);
		const before = rehydrated.mock.calls.length;
		await emit(MANAGED_AGENT_REHOSTED_EVENT, notification(1));
		await durableAppStorage.flush();
		expect(rehydrated).toHaveBeenCalledTimes(before);
		expect(useStore.getState().agents[0]).toEqual(agent(0));
		expect(durableAgent()).toEqual(agent(2));

		stopWindowSync = startWindowSync();
		await vi.waitFor(() =>
			expect(rehydrated.mock.calls.length).toBeGreaterThan(before),
		);
		expect(useStore.getState().agents[0]).toEqual(agent(2));
		await notifyAndRehydrate(MANAGED_AGENT_REHOSTED_EVENT, notification(1));
		expect(useStore.getState().agents[0]).toEqual(agent(2));
		expect(durableAgent()).toEqual(agent(2));
		expect(native.invoke).not.toHaveBeenCalled();
	});
});
