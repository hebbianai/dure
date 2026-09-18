import { describe, expect, it, vi } from "vitest";
import type { createDureBrowserClient } from "@/lib/ipc/dureBrowser";
import { captureBrowserElement } from "./browserElementCapture";
import { BrowserPaneSession } from "./browserPaneSession";
import type {
	BrowserControlProjection,
	BrowserFrame,
	BrowserObservation,
	BrowserPageIdentity,
} from "./browserResourceContract";

const resource = {
	resource_id: "browser:one",
	workspace_id: "workspace:one",
	generation: "generation:one",
};
const page: BrowserPageIdentity = {
	resource,
	page_id: "page:one",
	document_revision: "1",
};
const second = { ...page, page_id: "page:two" };
const lease = { resource, controller_id: "view:one", epoch: "1" };
const initial: BrowserControlProjection = {
	resource,
	controller: lease,
	revision: "1",
	phase: "ready",
	next_command_sequence: "1",
	in_flight: null,
	requested_controller: null,
	current_page: page,
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
function observation(
	control = initial,
	pages = [page, second],
): BrowserObservation {
	return {
		control,
		pages: pages.map((page) => ({
			page,
			url: "about:blank",
			title: page.page_id,
			profile_id: "default",
		})),
	};
}
function frame(page: BrowserPageIdentity): BrowserFrame {
	return {
		page,
		mimeType: "image/jpeg",
		base64: "aW1hZ2U=",
		viewport: { width: 400, height: 600, pixel_ratio: 2 },
	};
}
function fixture(
	decode: (frame: BrowserFrame) => Promise<string> = async (frame) =>
		frame.page.page_id,
) {
	let current = initial;
	const client = {
		observe: vi.fn(async () => observation(current)),
		frame: vi.fn(async (page: BrowserPageIdentity) => frame(page)),
		control: vi.fn(async () => current),
		action: vi
			.fn<ReturnType<typeof createDureBrowserClient>["action"]>()
			.mockImplementation(async (_caller, _authority, action) => {
				current = {
					...current,
					revision: String(BigInt(current.revision) + 1n),
					next_command_sequence: String(
						BigInt(current.next_command_sequence) + 1n,
					),
					keyboard:
						action.kind === "key_down"
							? { page, keys: [action.key] }
							: undefined,
				};
				return {
					control: current,
					response: { success: true },
					observation: null,
				};
			}),
		requestControl: vi
			.fn<ReturnType<typeof createDureBrowserClient>["requestControl"]>()
			.mockImplementation(async (_resource, controllerId) => {
				current = {
					...current,
					revision: String(BigInt(current.revision) + 1n),
					controller: { ...lease, controller_id: controllerId, epoch: "2" },
				};
				return current;
			}),
		close: vi.fn(),
		create: vi.fn(),
		recoverCreation: vi.fn(),
		list: vi.fn(),
		selectResource: vi.fn(),
		workspaces: vi.fn(),
		profiles: vi.fn(),
		createProfile: vi.fn(),
		deleteProfile: vi.fn(),
		screenshot: vi.fn(),
		capture: vi.fn(),
		receipt: vi.fn(),
	};
	return {
		client,
		session: new BrowserPaneSession(
			client,
			resource,
			lease.controller_id,
			undefined,
			decode,
		),
		setControl: (value: BrowserControlProjection) => {
			current = value;
		},
	};
}

describe("Browser pane ordered input and frame lifetime", () => {
	it.each(["observe", "frame", "decode"] as const)(
		"replaces a transient %s failure with a fresh decoded frame",
		async (stage) => {
			const decode = vi.fn(async () => "first image");
			const { session, client } = fixture(decode);
			await session.refresh();
			const failed = new Error("temporary read failure");
			if (stage === "decode") decode.mockRejectedValueOnce(failed);
			else client[stage].mockRejectedValueOnce(failed);
			await session.refresh();
			expect(session.read().error).toBe(failed);
			decode.mockResolvedValue("new image");
			await session.refresh();
			expect(session.read().frame?.src).toBe("new image");
			expect(session.read().error).toBeUndefined();
			expect(client.action).not.toHaveBeenCalled();
			await session.dispose(false);
		},
	);

	it("preserves an uncertain input failure across failed and recovered reads", async () => {
		const { session, client } = fixture();
		await session.refresh();
		const failed = new Error("input reply lost");
		client.action.mockRejectedValueOnce(failed);
		await expect(
			session.input({ kind: "insert_text", text: "once" }),
		).rejects.toBe(failed);
		client.frame.mockRejectedValueOnce(new Error("temporary frame failure"));
		await session.refresh();
		expect(session.read().error).toBe(failed);
		await session.refresh();
		expect(session.read().frame).toBeDefined();
		expect(session.read().error).toBe(failed);
		expect(client.action).toHaveBeenCalledTimes(1);
		await session.dispose(false);
	});

	it("keeps an input failure that arrives while a recovering frame is decoding", async () => {
		const decode = vi.fn(async () => "first image");
		const { session, client } = fixture(decode);
		await session.refresh();
		client.frame.mockRejectedValueOnce(new Error("temporary frame failure"));
		await session.refresh();
		const pending = deferred<string>();
		decode.mockImplementationOnce(() => pending.promise);
		const refreshing = session.refresh();
		await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
		const failed = new Error("input reply lost");
		client.action.mockRejectedValueOnce(failed);
		await expect(
			session.input({ kind: "insert_text", text: "once" }),
		).rejects.toBe(failed);
		pending.resolve("recovered image");
		await refreshing;
		expect(session.read().frame?.src).toBe("recovered image");
		expect(session.read().error).toBe(failed);
		expect(client.action).toHaveBeenCalledTimes(1);
		await session.dispose(false);
	});

	it("does not clear a failed frame when an independent input succeeds", async () => {
		const { session, client } = fixture();
		await session.refresh();
		const failed = new Error("frame unavailable");
		client.frame.mockRejectedValueOnce(failed);
		await session.refresh();
		await session.input({ kind: "insert_text", text: "once" });
		expect(session.read().error).toBe(failed);
		await session.refresh();
		expect(session.read().error).toBeUndefined();
		expect(client.action).toHaveBeenCalledTimes(1);
		await session.dispose(false);
	});

	it("refuses a queued handback after the observed controller changes", async () => {
		const { session, client } = fixture();
		await session.refresh();
		client.control.mockResolvedValueOnce({
			...initial,
			revision: "3",
			controller: { ...lease, controller_id: "another-agent", epoch: "3" },
		});
		await expect(session.handoff("human-view", lease)).rejects.toThrow(
			"browser_controller_changed",
		);
		expect(client.requestControl).not.toHaveBeenCalled();
		await session.dispose(false);
	});

	it("coalesces positioned wheels only at the same point and retains intervening moves", async () => {
		const { session, client } = fixture();
		await session.refresh();
		const pending = deferred<Awaited<ReturnType<typeof client.action>>>();
		client.action.mockImplementationOnce(() => pending.promise);
		const jobs = [session.input({ kind: "insert_text", text: "before" })];
		const wheel = (x: number, delta_y: number) =>
			({
				kind: "mouse",
				action: { kind: "wheel", x, y: 200, delta_x: 0, delta_y },
			}) as const;
		const move = {
			kind: "mouse",
			action: { kind: "move", x: 100, y: 200 },
		} as const;
		for (const action of [
			wheel(100, 2),
			wheel(100, 3),
			wheel(101, 4),
			wheel(101, -2),
			move,
			wheel(102, 3),
			move,
		])
			jobs.push(session.input(action));
		pending.resolve({
			control: initial,
			response: { success: true },
			observation: null,
		});
		await Promise.all(jobs);
		expect(client.action.mock.calls.map(([, , action]) => action)).toEqual([
			{ kind: "insert_text", text: "before" },
			wheel(100, 5),
			wheel(101, 4),
			wheel(101, -2),
			move,
			wheel(102, 3),
			move,
		]);
		await session.dispose(false);
	});

	it("keeps a wheel burst bounded behind slow input without losing distance or a later click", async () => {
		const { session, client } = fixture();
		await session.refresh();
		const pending = deferred<Awaited<ReturnType<typeof client.action>>>();
		client.action.mockImplementationOnce(() => pending.promise);
		const jobs = [session.input({ kind: "insert_text", text: "before" })];
		for (let index = 0; index < 40; index++) {
			jobs.push(
				session.input({
					kind: "mouse",
					action: { kind: "move", x: 100, y: 200 },
				}),
			);
			jobs.push(
				session.input({
					kind: "mouse",
					action: { kind: "wheel", delta_x: 0, delta_y: 2 },
				}),
			);
		}
		jobs.push(
			session.input({
				kind: "mouse",
				action: { kind: "down", button: "left", x: 100, y: 200 },
			}),
		);
		jobs.push(
			session.input({
				kind: "mouse",
				action: { kind: "up", button: "left", x: 100, y: 200 },
			}),
		);
		pending.resolve({
			control: initial,
			response: { success: true },
			observation: null,
		});
		await Promise.all(jobs);
		const delivered = client.action.mock.calls.map(([, , action]) => action);
		await session.dispose(false);
		expect(delivered).toEqual([
			{ kind: "insert_text", text: "before" },
			{ kind: "mouse", action: { kind: "move", x: 100, y: 200 } },
			{ kind: "mouse", action: { kind: "wheel", delta_x: 0, delta_y: 80 } },
			{
				kind: "mouse",
				action: { kind: "down", button: "left", x: 100, y: 200 },
			},
			{ kind: "mouse", action: { kind: "up", button: "left", x: 100, y: 200 } },
		]);
	});

	it("keeps wheel reversals, position changes, keys, pages and proposal limits ordered", async () => {
		const { session, client } = fixture();
		await session.refresh();
		const pending = deferred<Awaited<ReturnType<typeof client.action>>>();
		client.action.mockImplementationOnce(() => pending.promise);
		const jobs = [session.input({ kind: "insert_text", text: "before" })];
		const move = (x: number) =>
			({ kind: "mouse", action: { kind: "move", x, y: 200 } }) as const;
		const wheel = (delta_y: number) =>
			({
				kind: "mouse",
				action: { kind: "wheel", delta_x: 0, delta_y },
			}) as const;
		const actions = [
			move(100),
			wheel(2),
			wheel(-3),
			move(120),
			wheel(-4),
			{ kind: "key_down", key: "Shift" } as const,
			wheel(-5),
			{ kind: "key_up", key: "Shift" } as const,
			wheel(800_000),
			wheel(300_000),
		];
		for (const action of actions) jobs.push(session.input(action));
		jobs.push(session.input(wheel(2), second));
		pending.resolve({
			control: initial,
			response: { success: true },
			observation: null,
		});
		await Promise.all(jobs);
		const calls = [...client.action.mock.calls];
		await session.dispose(false);
		expect(calls.slice(1).map(([, , action]) => action)).toEqual([
			...actions,
			wheel(2),
		]);
		expect(calls[calls.length - 1]?.[1].page).toEqual(second);
	});

	it("rejects every coalesced wheel waiter when the preceding action transfers control", async () => {
		const { session, client } = fixture();
		await session.refresh();
		const pending = deferred<Awaited<ReturnType<typeof client.action>>>();
		client.action.mockImplementationOnce(() => pending.promise);
		const first = session.input({ kind: "insert_text", text: "before" });
		const jobs = [];
		for (let index = 0; index < 20; index++) {
			jobs.push(
				session.input({
					kind: "mouse",
					action: { kind: "move", x: 100, y: 200 },
				}),
			);
			jobs.push(
				session.input({
					kind: "mouse",
					action: { kind: "wheel", delta_x: 0, delta_y: 2 },
				}),
			);
		}
		const settled = Promise.allSettled(jobs);
		pending.resolve({
			control: {
				...initial,
				revision: "2",
				controller: { ...lease, controller_id: "other", epoch: "2" },
			},
			response: { success: true },
			observation: null,
		});
		await first;
		const outcomes = await settled;
		await session.dispose(false);
		expect(outcomes).toHaveLength(40);
		for (const outcome of outcomes) {
			expect(outcome.status).toBe("rejected");
			if (outcome.status === "rejected")
				expect(outcome.reason.message).toBe("browser_controller_changed");
		}
		expect(client.action).toHaveBeenCalledTimes(1);
	});
	it("retains the inspected tab when an observation fails during profile replacement", async () => {
		const { session, client } = fixture();
		await session.refresh();
		session.selectPage(page.page_id);
		const response = deferred<Awaited<ReturnType<typeof client.action>>>();
		client.action.mockImplementationOnce(() => response.promise);
		const changing = session.input({
			kind: "profile_set",
			profile_id: "default",
		});
		client.observe.mockResolvedValueOnce({
			control: { ...initial, revision: "2", in_flight: "operation:profile" },
			pages: [],
			observation_error: "browser_resource_observation_changed",
		});
		await session.refresh();
		const unavailable = session.read();
		const replaced = { ...page, document_revision: "2" };
		const completed = {
			...initial,
			revision: "3",
			next_command_sequence: "2",
			current_page: second,
		};
		response.resolve({
			control: completed,
			observation: observation(completed, [replaced, second]),
			replacedPage: replaced,
			response: { success: true },
		});
		await changing;
		const recovered = session.read();
		await session.dispose(false);
		expect(unavailable.page).toBeUndefined();
		expect(unavailable.frame).toBeUndefined();
		expect(unavailable.selectedPageId).toBe(page.page_id);
		expect(unavailable.followingCurrent).toBe(false);
		expect(unavailable.error?.message).toBe(
			"browser_resource_observation_changed",
		);
		expect(recovered.page).toEqual(replaced);
		expect(recovered.followingCurrent).toBe(false);
		expect(recovered.error).toBeUndefined();
		expect(client.action).toHaveBeenCalledTimes(1);
	});
	it.each([false, true])(
		"recovers a failed observation without changing viewer intent (pinned: %s)",
		async (pinned) => {
			const { session, client } = fixture();
			await session.refresh();
			if (pinned) session.selectPage(page.page_id);
			const failed = {
				control: { ...initial, revision: "2", current_page: second },
				pages: [],
				observation_error: "browser_resource_observation_changed",
			};
			client.observe.mockResolvedValueOnce(failed);
			await session.refresh();
			const unavailable = session.read();
			await expect(
				session.input({ kind: "insert_text", text: "unavailable" }),
			).rejects.toThrow("browser_controller_changed");
			client.observe.mockResolvedValueOnce(
				observation({ ...failed.control, revision: "3" }),
			);
			await session.refresh();
			const recovered = session.read();
			client.observe.mockResolvedValueOnce({
				control: { ...initial, revision: "4", current_page: undefined },
				pages: [],
			});
			await session.refresh();
			const closed = session.read();
			await session.dispose(false);
			expect(unavailable.frame).toBeUndefined();
			expect(unavailable.page).toBeUndefined();
			expect(unavailable.followingCurrent).toBe(!pinned);
			expect(unavailable.error?.message).toBe(failed.observation_error);
			expect(recovered.page).toEqual(pinned ? page : second);
			expect(recovered.frame?.capture.page).toEqual(recovered.page);
			expect(recovered.error).toBeUndefined();
			expect(closed.selectedPageId).toBeUndefined();
			expect(closed.followingCurrent).toBe(true);
			expect(client.action).not.toHaveBeenCalled();
		},
	);
	it("applies a controller change carried by a failed observation", async () => {
		const { session, client } = fixture();
		await session.refresh();
		session.selectPage(page.page_id);
		const failed = {
			control: {
				...initial,
				revision: "2",
				controller: { ...lease, controller_id: "agent:two", epoch: "2" },
			},
			pages: [],
			observation_error: "browser_resource_observation_changed",
		};
		client.observe.mockResolvedValueOnce(failed);
		await session.refresh();
		const unavailable = session.read();
		await session.dispose(false);
		expect(unavailable.control?.controller).toEqual(failed.control.controller);
		expect(unavailable.followingCurrent).toBe(true);
		expect(unavailable.frame).toBeUndefined();
		expect(unavailable.page).toBeUndefined();
		expect(unavailable.error?.message).toBe(failed.observation_error);
		expect(client.action).not.toHaveBeenCalled();
	});
	it.each([false, true])(
		"discards the replaced profile document before a delayed observation resolves (pinned: %s)",
		async (pinned) => {
			const { session, client } = fixture();
			await session.refresh();
			if (pinned) session.selectPage(page.page_id);
			const stale = deferred<BrowserObservation>();
			client.observe.mockImplementationOnce(() => stale.promise);
			const refreshing = session.refresh();
			const replaced = { ...page, document_revision: "2" };
			const control = {
				...initial,
				revision: "2",
				next_command_sequence: "2",
				current_page: replaced,
			};
			client.action.mockResolvedValueOnce({
				control,
				response: {
					success: true,
					data: { page: replaced, profile_id: "profile:next" },
				},
				observation: null,
				replacedPage: replaced,
			});
			await session.input(
				{ kind: "profile_set", profile_id: "profile:next" },
				page,
			);
			const completed = session.read();
			stale.resolve(observation());
			await refreshing;
			const afterStale = session.read();
			client.observe.mockResolvedValueOnce(
				observation(control, [replaced, second]),
			);
			await session.refresh();
			const final = session.read();
			await session.dispose(false);
			expect(completed.frame).toBeUndefined();
			expect(completed.page).toBeUndefined();
			expect(afterStale.frame).toBeUndefined();
			expect(afterStale.page).toBeUndefined();
			expect(final.page).toEqual(replaced);
			expect(final.frame?.capture.page).toEqual(replaced);
			expect(final.followingCurrent).toBe(!pinned);
		},
	);
	it.each(["queued", "response", "acknowledged", "response-lost"] as const)(
		"preserves a newer inspected page during a %s return to the agent",
		async (stage) => {
			const { session, client, setControl } = fixture();
			const source = { ...initial, current_page: second };
			setControl(source);
			await session.refresh();
			session.selectPage(second.page_id);
			const input = deferred<Awaited<ReturnType<typeof client.action>>>();
			const reply = deferred<BrowserControlProjection>();
			client.requestControl.mockImplementationOnce(() => reply.promise);
			let earlier = Promise.resolve<unknown>(undefined);
			if (stage === "queued") {
				client.action.mockImplementationOnce(() => input.promise);
				earlier = session.input({ kind: "key_up", key: "ShiftLeft" });
			}
			const returning = session.handoff("agent:one").then(
				() => undefined,
				(error: Error) => error,
			);
			if (stage === "queued") session.selectPage(page.page_id);
			input.resolve({
				control: source,
				response: { success: true },
				observation: null,
			});
			await earlier;
			await vi.waitFor(() =>
				expect(client.requestControl).toHaveBeenCalledTimes(1),
			);
			if (stage === "response" || stage === "response-lost")
				session.selectPage(page.page_id);
			const pending = {
				...source,
				revision: "2",
				requested_controller: "agent:one",
				in_flight: "operation:held",
			};
			setControl(pending);
			if (stage === "response-lost") reply.reject(new Error("response lost"));
			else reply.resolve(pending);
			const returned = await returning;
			if (stage === "response-lost")
				expect(returned?.message).toBe("response lost");
			else expect(returned).toBeUndefined();
			if (stage === "acknowledged") session.selectPage(page.page_id);
			setControl({
				...source,
				revision: "3",
				controller: { ...lease, controller_id: "agent:one", epoch: "2" },
			});
			await session.refresh();
			const selected = session.read();
			await expect(
				session.input({
					kind: "insert_text",
					text: "must stay observation-only",
				}),
			).rejects.toThrow("browser_controller_changed");
			await session.dispose(false);
			expect(selected.followingCurrent).toBe(false);
			expect(selected.page).toEqual(page);
			expect(selected.frame?.capture.page).toEqual(page);
			expect(client.action).toHaveBeenCalledTimes(stage === "queued" ? 1 : 0);
			expect(client.requestControl).toHaveBeenCalledTimes(1);
		},
	);

	it("does not reuse a return selection intent after a new ownership epoch", async () => {
		const { session, client, setControl } = fixture();
		await session.refresh();
		client.requestControl.mockResolvedValueOnce({
			...initial,
			revision: "2",
			requested_controller: "agent:one",
		});
		await session.handoff("agent:one");
		session.selectPage(second.page_id);
		setControl({
			...initial,
			revision: "3",
			controller: { ...lease, controller_id: "agent:one", epoch: "2" },
		});
		await session.refresh();
		expect(session.read().page).toEqual(second);
		setControl({
			...initial,
			revision: "4",
			controller: { ...lease, epoch: "3" },
			current_page: second,
		});
		await session.refresh();
		setControl({
			...initial,
			revision: "5",
			controller: { ...lease, controller_id: "agent:other", epoch: "4" },
		});
		await session.refresh();
		const selected = session.read();
		await session.dispose(false);
		expect(selected.followingCurrent).toBe(true);
		expect(selected.page).toEqual(page);
		expect(client.action).not.toHaveBeenCalled();
		expect(client.requestControl).toHaveBeenCalledTimes(1);
	});

	it("selects the inspected page when an acknowledged handoff is granted later", async () => {
		const { session, client, setControl } = fixture();
		const agent = { ...lease, controller_id: "agent:one" };
		setControl({ ...initial, controller: agent });
		await session.refresh();
		session.selectPage(second.page_id);
		client.requestControl.mockResolvedValueOnce({
			...initial,
			controller: agent,
			revision: "2",
			requested_controller: lease.controller_id,
			in_flight: "operation:agent",
		});
		await session.handoff(lease.controller_id);
		expect(session.read().control?.controller).toEqual(agent);
		expect(client.action).not.toHaveBeenCalled();
		const granted = { ...lease, epoch: "2" };
		setControl({ ...initial, revision: "3", controller: granted });
		await session.refresh();
		await vi.waitFor(() => expect(client.action).toHaveBeenCalledTimes(1));
		expect(client.action.mock.calls[0]).toEqual([
			lease.controller_id,
			expect.objectContaining({ lease: granted, page: second }),
			{ kind: "select_page" },
		]);
		await session.refresh();
		expect(client.action).toHaveBeenCalledTimes(1);
		await session.dispose(false);
	});

	it("resumes following only after a pending return actually changes controller", async () => {
		const { session, client, setControl } = fixture();
		await session.refresh();
		session.selectPage(second.page_id);
		client.requestControl.mockResolvedValueOnce({
			...initial,
			revision: "2",
			requested_controller: "agent:one",
			in_flight: "operation:human",
		});
		await session.handoff("agent:one");
		expect(session.read().followingCurrent).toBe(false);
		expect(session.read().page).toEqual(second);
		setControl({
			...initial,
			revision: "3",
			controller: { ...lease, controller_id: "agent:one", epoch: "2" },
		});
		await session.refresh();
		expect(session.read().followingCurrent).toBe(true);
		expect(session.read().page).toEqual(page);
		expect(client.action).not.toHaveBeenCalled();
		await session.dispose(false);
	});

	it("refuses new input while Host is transferring the current controller", async () => {
		const { session, client, setControl } = fixture();
		setControl({ ...initial, requested_controller: "agent:one" });
		await session.refresh();
		await expect(
			session.input({ kind: "insert_text", text: "must not be submitted" }),
		).rejects.toThrow("browser_controller_changed");
		expect(client.action).not.toHaveBeenCalled();
		await session.dispose(false);
	});

	it("does not dispatch queued input after the preceding handoff becomes pending", async () => {
		const { session, client } = fixture();
		await session.refresh();
		const first = deferred<Awaited<ReturnType<typeof client.action>>>();
		client.action.mockImplementationOnce(() => first.promise);
		const one = session.input({ kind: "key_down", key: "ShiftLeft" });
		const handoff = session.handoff("agent:one");
		const queued = session.input({ kind: "insert_text", text: "queued" });
		const rejected = expect(queued).rejects.toThrow(
			"browser_controller_changed",
		);
		const held = {
			...initial,
			revision: "2",
			next_command_sequence: "2",
			keyboard: { page, keys: ["ShiftLeft"] },
		};
		client.requestControl.mockResolvedValueOnce({
			...held,
			revision: "3",
			requested_controller: "agent:one",
		});
		first.resolve({
			control: held,
			response: { success: true },
			observation: null,
		});
		await Promise.all([one, handoff, rejected]);
		expect(client.action).toHaveBeenCalledTimes(1);
		expect(session.read().control?.requested_controller).toBe("agent:one");
		await session.dispose(false);
	});

	it("does not replay a failed selection when the granted lease is observed again", async () => {
		const { session, client, setControl } = fixture();
		setControl({
			...initial,
			controller: { ...lease, controller_id: "agent:one" },
		});
		await session.refresh();
		session.selectPage(second.page_id);
		client.action.mockRejectedValueOnce(new Error("selection reply lost"));
		setControl({
			...initial,
			revision: "2",
			controller: { ...lease, epoch: "2" },
		});
		await session.refresh();
		await vi.waitFor(() => expect(client.action).toHaveBeenCalledTimes(1));
		expect(session.read().error?.message).toBe("selection reply lost");
		await session.refresh();
		await session.refresh();
		expect(client.action).toHaveBeenCalledTimes(1);
		await session.dispose(false);
	});

	it("does not select a closed inspected page when control is granted", async () => {
		const { session, client, setControl } = fixture();
		setControl({
			...initial,
			controller: { ...lease, controller_id: "agent:one" },
		});
		await session.refresh();
		session.selectPage(second.page_id);
		const granted = {
			...initial,
			revision: "2",
			controller: { ...lease, epoch: "2" },
		};
		setControl(granted);
		client.observe.mockResolvedValueOnce(observation(granted, [page]));
		await session.refresh();
		expect(session.read().page).toEqual(page);
		expect(session.read().followingCurrent).toBe(true);
		expect(client.action).not.toHaveBeenCalled();
		await session.dispose(false);
	});

	it("does not select from a grant arriving after the pane was disposed", async () => {
		const { session, client, setControl } = fixture();
		setControl({
			...initial,
			controller: { ...lease, controller_id: "agent:one" },
		});
		await session.refresh();
		session.selectPage(second.page_id);
		const pending = deferred<BrowserObservation>();
		client.observe.mockImplementationOnce(() => pending.promise);
		const refreshing = session.refresh();
		await session.dispose(false);
		pending.resolve(
			observation({
				...initial,
				revision: "2",
				controller: { ...lease, epoch: "2" },
			}),
		);
		await refreshing;
		expect(client.action).not.toHaveBeenCalled();
	});

	it("follows the controller's non-first current tab and its later document", async () => {
		const { session, client, setControl } = fixture();
		setControl({ ...initial, current_page: second });
		await session.refresh();
		expect(session.read().page).toEqual(second);
		expect(client.frame).toHaveBeenLastCalledWith(second);
		expect(session.read().followingCurrent).toBe(true);
		const navigated = { ...second, document_revision: "2" };
		const next = { ...initial, revision: "2", current_page: navigated };
		setControl(next);
		client.observe.mockResolvedValueOnce(observation(next, [page, navigated]));
		await session.refresh();
		expect(session.read().frame?.capture.page).toEqual(navigated);
		expect(client.action).not.toHaveBeenCalled();
		await session.dispose(false);
	});

	it("allows an observer to pin a page and resume following without acquiring control", async () => {
		const { session, client, setControl } = fixture();
		setControl({
			...initial,
			controller: { ...lease, controller_id: "agent" },
			current_page: second,
		});
		await session.refresh();
		session.selectPage(page.page_id);
		await session.refresh();
		expect(session.read().page).toEqual(page);
		expect(session.read().followingCurrent).toBe(false);
		expect(session.read().control?.current_page).toEqual(second);
		session.selectPage(undefined);
		await session.refresh();
		expect(session.read().frame?.capture.page).toEqual(second);
		expect(session.read().followingCurrent).toBe(true);
		expect(client.action).not.toHaveBeenCalled();
		expect(client.requestControl).not.toHaveBeenCalled();
		await session.dispose(false);
	});

	it("does not present an arbitrary first page when the current target is absent", async () => {
		const { session, client, setControl } = fixture();
		setControl({ ...initial, current_page: undefined });
		await session.refresh();
		expect(session.read().page).toBeUndefined();
		expect(session.read().frame).toBeUndefined();
		expect(client.frame).not.toHaveBeenCalled();
		await expect(
			session.input({ kind: "insert_text", text: "unknown" }),
		).rejects.toThrow("browser_controller_changed");
		expect(client.action).not.toHaveBeenCalled();
		await session.dispose(false);
	});

	it("returns to the current target when the inspected page closes", async () => {
		const { session, client } = fixture();
		await session.refresh();
		session.selectPage(page.page_id);
		const third = { ...page, page_id: "page:three" };
		client.observe.mockResolvedValueOnce(
			observation({ ...initial, revision: "2", current_page: third }, [
				second,
				third,
			]),
		);
		await session.refresh();
		expect(session.read().page).toEqual(third);
		expect(session.read().followingCurrent).toBe(true);
		await session.dispose(false);
	});

	it("returns the admitted action data to the capture consumer without replay", async () => {
		const { client, session } = fixture();
		await session.refresh();
		const data = {
			result: { label: "button#save", html: "<button>저장</button>" },
		};
		client.action.mockResolvedValueOnce({
			control: { ...initial, revision: "2", next_command_sequence: "2" },
			response: { success: true, data },
			observation: null,
		});
		const result = await session.input({
			kind: "insert_text",
			text: "before capture",
		});
		expect(result).toEqual(data);
		expect(client.action).toHaveBeenCalledTimes(1);
		await session.dispose(false);
	});

	it.each(["new_page", "profile_clone"] as const)(
		"selects the Host-created page without guessing from observation order (%s)",
		async (kind) => {
			const { client, session } = fixture();
			await session.refresh();
			const created = { ...page, page_id: "page:created" };
			const after = { ...initial, revision: "2", next_command_sequence: "2" };
			client.action.mockResolvedValueOnce({
				control: after,
				response: { success: true },
				createdPage: created,
				observation: observation(after, [page, created, second]),
			});
			await session.input(
				kind === "new_page"
					? { kind, url: "about:blank" }
					: { kind, profile_id: "profile:next" },
			);
			expect(session.read().page).toEqual(created);
			expect(session.read().frame).toBeUndefined();
			expect(client.action).toHaveBeenCalledTimes(1);
			await session.dispose(false);
		},
	);

	it.each(["new_page", "profile_clone"] as const)(
		"waits for a fresh creation observation without rendering the old page or replaying create (%s)",
		async (kind) => {
			const { client, session } = fixture();
			await session.refresh();
			const old = deferred<BrowserObservation>();
			client.observe.mockImplementationOnce(() => old.promise);
			const refreshing = session.refresh();
			const created = { ...page, page_id: "page:created" };
			const after = { ...initial, revision: "2", next_command_sequence: "2" };
			client.action.mockResolvedValueOnce({
				control: after,
				response: { success: true },
				observation: null,
				createdPage: created,
			});
			await session.input(
				kind === "new_page"
					? { kind, url: "about:blank" }
					: { kind, profile_id: "profile:next" },
			);
			expect(session.read().page).toBeUndefined();
			expect(session.read().frame).toBeUndefined();
			old.resolve(observation());
			await refreshing;
			expect(session.read().page).toBeUndefined();
			expect(client.frame).toHaveBeenCalledTimes(1);
			client.observe.mockResolvedValueOnce(
				observation(after, [page, created, second]),
			);
			await session.refresh();
			expect(session.read().page).toEqual(created);
			expect(session.read().frame?.capture.page).toEqual(created);
			expect(client.action).toHaveBeenCalledTimes(1);
			await session.dispose(false);
		},
	);

	it.each([[second.page_id], [second.page_id, page.page_id]])(
		"preserves explicit selection %j while a new-page reply is pending",
		async (...selection) => {
			const { client, session } = fixture();
			await session.refresh();
			const pending = deferred<Awaited<ReturnType<typeof client.action>>>();
			client.action.mockImplementationOnce(() => pending.promise);
			const creating = session.input({ kind: "new_page", url: "about:blank" });
			for (const id of selection) session.selectPage(id);
			const created = { ...page, page_id: "page:created" };
			const after = { ...initial, revision: "2", next_command_sequence: "2" };
			pending.resolve({
				control: after,
				response: { success: true },
				createdPage: created,
				observation: observation(after, [page, created, second]),
			});
			await creating;
			expect(session.read().page?.page_id).toBe(
				selection[selection.length - 1],
			);
			await session.dispose(false);
		},
	);

	it("coalesces adjacent resize intents without moving them across user input", async () => {
		const { client, session, setControl } = fixture();
		await session.refresh();
		const pending = deferred<Awaited<ReturnType<typeof client.action>>>();
		client.action.mockImplementationOnce(() => pending.promise);
		const first = session.input({ kind: "insert_text", text: "before" });
		const resize = (width: number) =>
			session.input({
				kind: "environment",
				action: {
					kind: "viewport",
					width,
					height: 610,
					scale: 1,
					mobile: false,
				},
			});
		const a = resize(480);
		const b = resize(640);
		const middle = session.input({ kind: "insert_text", text: "between" });
		const c = resize(800);
		const d = resize(960);
		setControl({ ...initial, revision: "2", next_command_sequence: "2" });
		pending.resolve({
			control: { ...initial, revision: "2", next_command_sequence: "2" },
			response: { success: true },
			observation: null,
		});
		await Promise.all([first, a, b, middle, c, d]);
		expect(client.action.mock.calls.map((call) => call[2])).toEqual([
			{ kind: "insert_text", text: "before" },
			{
				kind: "environment",
				action: {
					kind: "viewport",
					width: 640,
					height: 610,
					scale: 1,
					mobile: false,
				},
			},
			{ kind: "insert_text", text: "between" },
			{
				kind: "environment",
				action: {
					kind: "viewport",
					width: 960,
					height: 610,
					scale: 1,
					mobile: false,
				},
			},
		]);
		expect(
			client.action.mock.calls.map((call) => call[1].command_sequence),
		).toEqual(["1", "2", "3", "4"]);
		await session.dispose(false);
	});
	it("coalesces refresh and discards a decoded frame after selecting another page", async () => {
		const decoding = deferred<string>();
		const { client, session } = fixture(() => decoding.promise);
		const refresh = session.refresh();
		expect(session.refresh()).toBe(refresh);
		await vi.waitFor(() => expect(client.frame).toHaveBeenCalledTimes(1));
		session.selectPage(second.page_id);
		decoding.resolve("old-page-image");
		await refresh;
		expect(session.read().page).toEqual(second);
		expect(session.read().frame).toBeUndefined();
		await session.refresh();
		expect(session.read().frame?.capture.page).toEqual(second);
		await session.dispose(false);
	});

	it("orders blur release after submitted key-down and before the next input", async () => {
		const { client, session } = fixture();
		await session.refresh();
		const pending = deferred<Awaited<ReturnType<typeof client.action>>>();
		client.action.mockImplementationOnce(() => pending.promise);
		const down = session.input({ kind: "key_down", key: "ShiftLeft" });
		const released = session.release();
		expect(session.release()).toBe(released);
		const text = session.input({ kind: "insert_text", text: "한글" });
		const held = {
			...initial,
			revision: "2",
			next_command_sequence: "2",
			keyboard: { page, keys: ["ShiftLeft"] },
		};
		const current = { ...held, pointer: { page: second, buttons: 1 } };
		client.control.mockResolvedValueOnce(current);
		client.action.mockResolvedValueOnce({
			control: {
				...current,
				keyboard: undefined,
				revision: "3",
				next_command_sequence: "3",
			},
			response: { success: true },
			observation: null,
		});
		client.action.mockResolvedValueOnce({
			control: { ...initial, revision: "4", next_command_sequence: "4" },
			response: { success: true },
			observation: null,
		});
		pending.resolve({
			control: held,
			response: { success: true },
			observation: null,
		});
		await Promise.all([down, released, text]);
		expect(
			client.action.mock.calls.map((call) => [
				call[1].command_sequence,
				call[1].page.page_id,
				call[2],
			]),
		).toEqual([
			["1", "page:one", { kind: "key_down", key: "ShiftLeft" }],
			["2", "page:one", { kind: "key_up", key: "ShiftLeft" }],
			[
				"3",
				"page:two",
				{ kind: "mouse", action: { kind: "up", button: "left" } },
			],
			["4", "page:one", { kind: "insert_text", text: "한글" }],
		]);
		await session.dispose(false);
	});

	it("does not report failed key-up as confirmed cleanup", async () => {
		const { client, session, setControl } = fixture();
		setControl({ ...initial, keyboard: { page, keys: ["ControlLeft"] } });
		await session.refresh();
		client.action.mockResolvedValueOnce({
			control: { ...initial, keyboard: { page, keys: ["ControlLeft"] } },
			response: { success: false, error: "not released" },
			observation: null,
		});
		await expect(session.release()).rejects.toThrow("browser_action_failed");
		expect(client.action).toHaveBeenCalledTimes(1);
		expect(session.read().error?.message).toBe("browser_action_failed");
		await session.dispose(false);
	});

	it("does not release input belonging to a replacement controller epoch", async () => {
		const { client, session, setControl } = fixture();
		await session.refresh();
		setControl({
			...initial,
			controller: { ...lease, epoch: "2" },
			keyboard: { page, keys: ["ControlLeft"] },
		});
		await session.dispose();
		expect(client.action).not.toHaveBeenCalled();
		expect(client.close).not.toHaveBeenCalled();
	});

	it("rejects queued input when an earlier action grants another controller, without retry", async () => {
		const { client, session } = fixture();
		await session.refresh();
		const pending = deferred<Awaited<ReturnType<typeof client.action>>>();
		client.action.mockImplementationOnce(() => pending.promise);
		const one = session.input({ kind: "key_up", key: "ShiftLeft" });
		const two = session.input({
			kind: "insert_text",
			text: "must not dispatch",
		});
		const rejected = expect(two).rejects.toThrow("browser_controller_changed");
		pending.resolve({
			control: {
				...initial,
				revision: "2",
				controller: { ...lease, controller_id: "agent:other", epoch: "2" },
			},
			response: { success: true },
			observation: null,
		});
		await one;
		await rejected;
		expect(client.action).toHaveBeenCalledTimes(1);
		await session.dispose();
	});

	it("starts input queued by a completed job's continuation", async () => {
		const { client, session } = fixture();
		await session.refresh();
		await session
			.input({ kind: "insert_text", text: "one" })
			.then(() => session.input({ kind: "insert_text", text: "two" }));
		expect(
			client.action.mock.calls.map((call) => call[1].command_sequence),
		).toEqual(["1", "2"]);
		await session.dispose(false);
	});

	it("takes control after earlier input and keeps the Host's pending handoff projection", async () => {
		const { client, session } = fixture();
		await session.refresh();
		const one = session.input({ kind: "key_down", key: "ShiftLeft" });
		client.requestControl.mockResolvedValueOnce({
			...initial,
			revision: "3",
			next_command_sequence: "2",
			requested_controller: "agent:one",
			keyboard: { page, keys: ["ShiftLeft"] },
		});
		await Promise.all([one, session.handoff("agent:one")]);
		expect(client.requestControl.mock.calls[0].slice(0, 3)).toEqual([
			resource,
			"agent:one",
			lease,
		]);
		expect(session.read().control?.controller).toEqual(lease);
		expect(session.read().control?.requested_controller).toBe("agent:one");
		await session.dispose(false);
	});
});

const captureValue = {
	label: "button#save",
	path: "main > button#save",
	selector: "#save",
	ancestors: [],
	nearby: [],
	accessibility: { accessibleName: "저장" },
	html: "<button id=save>저장</button>",
	htmlElided: false,
	css: {},
	rect: { x: 0, y: 0, width: 10, height: 20 },
	pageRect: { x: 0, y: 0, width: 10, height: 20 },
};
for (const change of [
	"none",
	"large",
	"page",
	"document",
	"controller",
	"cancel",
] as const) {
	it(`handles a capture response after ${change} changes without replay`, async () => {
		const { client, session } = fixture();
		await session.refresh();
		const reply = deferred<Awaited<ReturnType<typeof client.action>>>();
		client.action.mockImplementationOnce(() => reply.promise);
		const lifetime = new AbortController();
		const attachment = { fileName: "element.png", dataB64: "cG5n" };
		const crop = vi.fn().mockResolvedValue(attachment);
		client.screenshot.mockResolvedValue({
			...frame(page),
			mimeType: "image/png",
		});
		client.capture.mockResolvedValue({ ...frame(page), mimeType: "image/png" });
		if (change === "large")
			client.screenshot.mockRejectedValue(
				new Error("browser_capture_requires_artifact"),
			);
		const capturing = captureBrowserElement(
			session,
			frame(page),
			{ x: 5, y: 10 },
			lifetime.signal,
			crop,
		);
		expect(client.action).toHaveBeenCalledTimes(1);
		expect(client.action.mock.calls[0][1].page).toEqual(page);
		expect(client.action.mock.calls[0][2].kind).toBe("evaluate");
		if (change === "page") {
			session.selectPage(second.page_id);
			session.selectPage(page.page_id);
		}
		if (change === "document") {
			client.observe.mockResolvedValueOnce(
				observation(initial, [{ ...page, document_revision: "2" }, second]),
			);
			await session.refresh();
		}
		if (change === "controller") {
			client.observe.mockResolvedValueOnce(
				observation({
					...initial,
					revision: "3",
					controller: { ...lease, epoch: "2", controller_id: "agent:two" },
				}),
			);
			await session.refresh();
		}
		if (change === "cancel") lifetime.abort();
		reply.resolve({
			control: { ...initial, revision: "2", next_command_sequence: "2" },
			response: {
				success: true,
				data: {
					result: {
						...captureValue,
						screenshotPath: "/untrusted/page/path.png",
					},
				},
			},
			observation: null,
		});
		expect(await capturing).toEqual(
			["none", "large"].includes(change)
				? { captured: captureValue, attachment }
				: undefined,
		);
		expect(client.action).toHaveBeenCalledTimes(1);
		await session.dispose(false);
	});
}

for (const outcome of ["cancel", "page", "failure"] as const) {
	it(`handles ${outcome} during image preparation without publishing an obsolete capture`, async () => {
		const { client, session } = fixture();
		await session.refresh();
		client.action.mockResolvedValueOnce({
			control: { ...initial, revision: "2", next_command_sequence: "2" },
			response: { success: true, data: { result: captureValue } },
			observation: null,
		});
		client.capture.mockResolvedValue({ ...frame(page), mimeType: "image/png" });
		const cropped = deferred<{ fileName: string; dataB64: string }>();
		const crop = vi.fn(() => cropped.promise);
		const lifetime = new AbortController();
		const result = captureBrowserElement(
			session,
			frame(page),
			undefined,
			lifetime.signal,
			crop,
		);
		await vi.waitFor(() => expect(crop).toHaveBeenCalledTimes(1));
		if (outcome === "cancel") lifetime.abort();
		if (outcome === "page") {
			session.selectPage(second.page_id);
			session.selectPage(page.page_id);
		}
		if (outcome === "failure") cropped.reject(new Error("decode failed"));
		else cropped.resolve({ fileName: "element.png", dataB64: "cG5n" });
		expect(await result).toEqual(
			outcome === "failure"
				? { captured: captureValue, attachmentError: true }
				: undefined,
		);
		expect(client.action).toHaveBeenCalledTimes(1);
		expect(client.capture).toHaveBeenCalledTimes(1);
		await session.dispose(false);
	});
}
