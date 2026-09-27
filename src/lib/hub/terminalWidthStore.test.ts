import { describe, expect, it, vi } from "vitest";
import type { HmuxPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import {
	createHubTerminalWidthStore,
	hubTerminalWidthSnapshot,
	type HubTerminalWidthSnapshot,
	widthForHubTerminal,
} from "./terminalWidthStore";

const binding: HmuxPaneBindingV1 = {
	schemaVersion: 1,
	runtime: "hmux_session_v1",
	source: "local",
	hostId: "local",
	sessionId: "session",
	workspaceId: "workspace",
};
function snapshot(
	revision = "1",
	columns = [53],
	generation = "service-a",
): HubTerminalWidthSnapshot {
	return {
		generation,
		revision,
		observations: columns.map((columns) => ({
			route: { source: "local", hostId: "local" },
			fence: {
				workspace_id: "workspace",
				session_id: "session",
				runner_principal: "runner",
				runner_instance: "instance",
				channel_epoch: "1",
				host_instance_id: "host",
				terminal_epoch: "epoch",
			},
			columns,
		})),
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};
function harness() {
	const initial = deferred<unknown>();
	let receive!: (payload: unknown) => void;
	const unlisten = vi.fn();
	const transport = {
		listen: vi.fn(async (listener: typeof receive) => {
			receive = listener;
			return unlisten;
		}),
		snapshot: vi.fn(() => initial.promise),
	};
	const store = createHubTerminalWidthStore(transport);
	return {
		store,
		transport,
		initial,
		unlisten,
		emit: (value: unknown) => receive(value),
	};
}

describe("Hub terminal width observations", () => {
	it("refetches when a replacement generation arrives during a delayed snapshot", async () => {
		const h = harness();
		const stop = h.store.subscribe(vi.fn());
		await flush();
		const replacement = deferred<unknown>();
		h.transport.snapshot.mockReturnValue(replacement.promise);
		h.emit(snapshot("2", [70], "service-b"));
		h.initial.resolve(snapshot("8", [38], "service-a"));
		await flush();
		expect(h.transport.snapshot).toHaveBeenCalledTimes(2);
		replacement.resolve(snapshot("1", [60], "service-b"));
		await flush();
		expect(h.store.getSnapshot()?.generation).toBe("service-b");
		expect(h.store.getSnapshot()?.observations[0].columns).toBe(70);
		h.emit(snapshot("99", [38], "service-a"));
		await flush();
		expect(h.transport.snapshot).toHaveBeenCalledTimes(2);
		expect(h.store.getSnapshot()?.observations[0].columns).toBe(70);
		stop();
	});
	it("uses the minimum verified phone proposal only for the installed binding/epoch", () => {
		expect(
			widthForHubTerminal(snapshot("1", [80, 53, 60]), binding, "epoch"),
		).toBe(53);
		expect(widthForHubTerminal(snapshot(), binding, null)).toBeUndefined();
		for (const field of ["sessionId", "workspaceId", "hostId"] as const) {
			expect(
				widthForHubTerminal(
					snapshot(),
					{ ...binding, [field]: "other" } as HmuxPaneBindingV1,
					"epoch",
				),
			).toBeUndefined();
		}
		expect(
			widthForHubTerminal(snapshot(), binding, "old-epoch"),
		).toBeUndefined();
		const remote = snapshot();
		remote.observations[0].route = { source: "ssh", hostId: "local" };
		expect(widthForHubTerminal(remote, binding, "epoch")).toBeUndefined();
		const remoteBinding: HmuxPaneBindingV1 = {
			...binding,
			runtime: "hmux_standalone_v1",
			source: "ssh",
			hostId: "remote",
			commandBridgeNonce: "nonce",
		};
		remote.observations[0].route.hostId = "remote";
		expect(widthForHubTerminal(remote, remoteBinding, "epoch")).toBe(53);
	});
	it("rejects invalid width and sequence payloads at the boundary", () => {
		for (const columns of [0, -1, 1.5, 1025, NaN])
			expect(
				hubTerminalWidthSnapshot(snapshot("1", [columns])),
			).toBeUndefined();
		for (const revision of ["-1", "1.5", "01", "18446744073709551616"])
			expect(hubTerminalWidthSnapshot(snapshot(revision))).toBeUndefined();
		expect(
			hubTerminalWidthSnapshot(snapshot("18446744073709551615")),
		).toBeDefined();
	});
	it("registers once before snapshot and lets a newer event beat a delayed snapshot", async () => {
		const h = harness();
		const stopA = h.store.subscribe(vi.fn());
		const stopB = h.store.subscribe(vi.fn());
		expect(h.transport.listen).toHaveBeenCalledOnce();
		expect(h.transport.snapshot).not.toHaveBeenCalled();
		await flush();
		h.emit(snapshot("3", [80]));
		h.initial.resolve(snapshot("1"));
		await flush();
		expect(h.store.getSnapshot()?.revision).toBe("3");
		h.emit(snapshot("2", [38]));
		expect(h.store.getSnapshot()?.observations[0].columns).toBe(80);
		stopA();
		expect(h.unlisten).not.toHaveBeenCalled();
		stopB();
		expect(h.unlisten).toHaveBeenCalledOnce();
		expect(h.store.getSnapshot()).toBeUndefined();
	});
	it("does not let an old service event override a new service snapshot", async () => {
		const h = harness();
		const stop = h.store.subscribe(vi.fn());
		await flush();
		h.emit(snapshot("999", [38], "old-service"));
		h.initial.resolve(snapshot("1", [53], "new-service"));
		await flush();
		expect(h.store.getSnapshot()?.generation).toBe("new-service");
		h.emit(snapshot("1000", [38], "old-service"));
		await flush();
		expect(h.store.getSnapshot()?.observations[0].columns).toBe(53);
		stop();
	});
	it("establishes a replacement service only through its native snapshot", async () => {
		const h = harness();
		const stop = h.store.subscribe(vi.fn());
		await flush();
		h.initial.resolve(snapshot());
		await flush();
		const replacement = deferred<unknown>();
		h.transport.snapshot.mockReturnValue(replacement.promise);
		h.emit(snapshot("2", [70], "service-b"));
		expect(h.store.getSnapshot()?.generation).toBe("service-a");
		replacement.resolve(snapshot("1", [60], "service-b"));
		await flush();
		expect(h.store.getSnapshot()?.generation).toBe("service-b");
		expect(h.store.getSnapshot()?.observations[0].columns).toBe(70);
		stop();
	});
	it("ignores pending listener and snapshot completion after the last pane unmounts", async () => {
		const h = harness();
		const listener = vi.fn();
		const stop = h.store.subscribe(listener);
		await flush();
		stop();
		h.initial.resolve(snapshot());
		h.emit(snapshot("2"));
		await flush();
		expect(listener).not.toHaveBeenCalled();
		expect(h.store.getSnapshot()).toBeUndefined();
		const registration = deferred<() => void>();
		const dispose = vi.fn();
		const store = createHubTerminalWidthStore({
			listen: () => registration.promise,
			snapshot: vi.fn(),
		});
		store.subscribe(vi.fn())();
		registration.resolve(dispose);
		await flush();
		expect(dispose).toHaveBeenCalledOnce();
	});
	it("restarts observation cleanly and applies removal snapshots", async () => {
		const h = harness();
		const stop = h.store.subscribe(vi.fn());
		await flush();
		h.initial.resolve(snapshot());
		await flush();
		h.emit(snapshot("2", []));
		expect(
			widthForHubTerminal(h.store.getSnapshot(), binding, "epoch"),
		).toBeUndefined();
		stop();
		const second = h.store.subscribe(vi.fn());
		await flush();
		expect(h.transport.listen).toHaveBeenCalledTimes(2);
		second();
	});
	it("falls back to ordinary desktop geometry on unavailable or malformed IPC", async () => {
		const h = harness();
		const stop = h.store.subscribe(vi.fn());
		await flush();
		h.initial.resolve(snapshot());
		await flush();
		h.emit({});
		expect(h.store.getSnapshot()).toBeUndefined();
		stop();
		const store = createHubTerminalWidthStore({
			listen: async () => () => {},
			snapshot: async () => {
				throw new Error("old backend");
			},
		});
		const dispose = store.subscribe(vi.fn());
		await flush();
		expect(store.getSnapshot()).toBeUndefined();
		dispose();
	});
});
