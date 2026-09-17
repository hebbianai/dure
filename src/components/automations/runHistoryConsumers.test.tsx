// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationRuns } from "@/components/automations/AutomationRuns";
import { GraphRuns } from "@/components/automations/GraphRuns";
import { setLang } from "@/lib/i18n";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { createGraphClient } from "@/lib/ipc/dureGraph";
import { createScheduleClient } from "@/lib/ipc/dureSchedule";

vi.mock("@/components/automations/GraphCanvas", () => ({
	GraphCanvas: ({ onSelect }: { onSelect: (id: string) => void }) => (
		<button type="button" onClick={() => onSelect("collect")}>
			Select step
		</button>
	),
}));

const local: DureBackendRouteAuthorityV1 = {
	schemaVersion: 1,
	profileId: "local",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend-local", generation: "g1" },
	target: { source: "local", hostId: "local" },
};
const secondary = {
	...local,
	profileId: "secondary",
	backend: { id: "backend-secondary", generation: "g2" },
};
const createdAt = (id: string) => (id === "first" ? 1000 : 2000);
function pendingResponse() {
	let resolve!: (value: unknown) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<unknown>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function fixture(kind: "graph" | "schedule") {
	let ids = ["first", "second"];
	const run = (id: string) => ({
		schemaVersion: 1,
		runId: id,
		workflowId: "daily",
		workflowVersion: 1,
		sourceDigest: "digest",
		status: "completed",
		trigger: { kind: "manual" },
		createdAtMs: createdAt(id),
		updatedAtMs: createdAt(id),
	});
	const occurrence = (id: string) => ({
		schemaVersion: 2,
		scheduleId: "daily",
		scheduleRevision: 1,
		idempotencyKey: id,
		launchState: "started",
		operationId: `operation-${id}`,
		trigger: { kind: "manual" },
		createdAtMs: createdAt(id),
		updatedAtMs: createdAt(id),
		run: {
			runId: id,
			taskId: "task",
			dispatchId: "dispatch",
			generation: 1,
			workspaceId: "workspace",
			completed: true,
		},
	});
	function response(
		route: DureBackendRouteAuthorityV1,
		operation: string,
		receipt: object,
	) {
		return {
			schemaVersion: 1,
			routeAuthority: route,
			backendId: route.backend.id,
			backendGeneration: route.backend.generation,
			result:
				kind === "graph"
					? {
							schemaVersion: 1,
							apiVersion: "dure.orchestration/v1",
							method: `workflow.graph.${operation}`,
							receipt: { schemaVersion: 1, ...receipt },
						}
					: { schemaVersion: 1, ...receipt },
		};
	}
	const listReply = (route = local) =>
		response(
			route,
			"runs",
			kind === "graph"
				? { runs: ids.map(run) }
				: { occurrences: ids.map(occurrence) },
		);
	function inspectReply(id: string, route = local) {
		const text = `Report ${id} ${route.profileId}`;
		if (kind === "schedule")
			return response(route, "inspect", {
				occurrence: occurrence(id),
				resultMarkdown: text,
			});
		const task = {
			nodeId: "collect",
			taskId: "task",
			dispatchId: "dispatch",
			action: { actionId: "command", version: 1 },
			state: {
				kind: "completed",
				inputs: {},
				outputs: { text },
				completedAtMs: 10,
			},
		};
		return response(route, "inspect", {
			run: run(id),
			task,
			tasks: [task],
			version: {
				schemaVersion: 1,
				workflowId: "daily",
				version: 1,
				sourceRevision: 1,
				digest: "digest",
				name: "Daily",
				trigger: { kind: "manual" },
				createdAtMs: 1,
				definition: {
					schemaVersion: 1,
					edges: [],
					nodes: [
						{
							nodeId: "collect",
							name: "Collect",
							action: task.action,
							inputs: {},
						},
					],
				},
			},
		});
	}
	const invokeCommand = vi.fn(async (_command, args): Promise<unknown> => {
		const route = args.route.authority;
		const operation = kind === "graph" ? args.body.method : args.operation;
		if (operation.endsWith(".runs") || operation.endsWith(".occurrences"))
			return listReply(route);
		const body = kind === "graph" ? args.body.body : args.body;
		return inspectReply(body.runId ?? body.idempotencyKey, route);
	});
	const graph = createGraphClient({ invokeCommand });
	const schedule = createScheduleClient({ invokeCommand });
	const calls = (operation: "list" | "inspect") =>
		invokeCommand.mock.calls.filter(([, args]) => {
			const method = kind === "graph" ? args.body.method : args.operation;
			return operation === "inspect"
				? method.endsWith(".inspect")
				: method.endsWith(".runs") || method.endsWith(".occurrences");
		});
	return {
		invokeCommand,
		calls,
		listReply,
		inspectReply,
		setIds: (next: string[]) => {
			ids = next;
		},
		view: (authority = local, initial?: string) =>
			kind === "graph" ? (
				<GraphRuns
					client={graph}
					authority={authority}
					workflowId="daily"
					initialRunId={initial}
				/>
			) : (
				<AutomationRuns
					client={schedule}
					authority={authority}
					scheduleId="daily"
					initialSelection={initial}
				/>
			),
	};
}

beforeEach(() => setLang("en"));
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	setLang("ko");
});

describe.each(["graph", "schedule"] as const)("%s run observation", (kind) => {
	it("reads and inspects the initial selection once", async () => {
		const f = fixture(kind);
		render(f.view());
		await screen.findByText("Report first local");
		expect(f.calls("list")).toHaveLength(1);
		expect(f.calls("inspect")).toHaveLength(1);
	});

	it("does not inspect a list that resolves after unmount", async () => {
		const f = fixture(kind);
		const pending = pendingResponse();
		f.invokeCommand.mockImplementationOnce(() => pending.promise);
		const { unmount } = render(f.view());
		unmount();
		await act(async () => pending.resolve(f.listReply()));
		expect(f.calls("inspect")).toHaveLength(0);
	});

	it.each(["success", "failure"])(
		"ignores an old authority's late inspection %s",
		async (outcome) => {
			const f = fixture(kind);
			const pending = pendingResponse();
			f.invokeCommand
				.mockResolvedValueOnce(f.listReply())
				.mockImplementationOnce(() => pending.promise);
			const { rerender } = render(f.view(local, "first"));
			await waitFor(() => expect(f.calls("inspect")).toHaveLength(1));
			rerender(f.view(secondary, "first"));
			await screen.findByText("Report first secondary");
			await act(async () => {
				if (outcome === "success") pending.resolve(f.inspectReply("first"));
				else pending.reject(new Error("retired inspection"));
			});
			expect(screen.getByText("Report first secondary")).toBeTruthy();
			expect(screen.queryByText("Report first local")).toBeNull();
			expect(screen.queryByText("retired inspection")).toBeNull();
			expect(f.calls("inspect")[1][1].route).toEqual({
				kind: "exact",
				authority: secondary,
			});
		},
	);

	it("keeps at most one read in flight and stops scheduling on unmount", async () => {
		vi.useFakeTimers();
		const f = fixture(kind);
		const pending = pendingResponse();
		f.invokeCommand.mockImplementationOnce(() => pending.promise);
		const { unmount } = render(f.view(local, "first"));
		await act(async () => vi.advanceTimersByTimeAsync(20000));
		expect(f.calls("list")).toHaveLength(1);
		await act(async () => pending.resolve(f.listReply()));
		expect(screen.getByText("Report first local")).toBeTruthy();
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(f.calls("list")).toHaveLength(2);
		unmount();
		await act(async () => vi.advanceTimersByTimeAsync(15000));
		expect(f.calls("list")).toHaveLength(2);
	});

	it("preserves the surface's default selection while new runs arrive", async () => {
		vi.useFakeTimers();
		const f = fixture(kind);
		await act(async () => {
			render(f.view());
		});
		f.setIds(["second", "first"]);
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(
			screen.getByText(`Report ${kind === "graph" ? "first" : "second"} local`),
		).toBeTruthy();
	});

	it("shows an explicit selection and preserves it through refresh", async () => {
		const f = fixture(kind);
		render(f.view());
		await screen.findByText("Report first local");
		fireEvent.click(screen.getByText(new Date(2000).toLocaleString()));
		await screen.findByText("Report second local");
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(f.calls("list")).toHaveLength(3));
		expect(screen.getByText("Report second local")).toBeTruthy();
	});

	it.each(["list", "inspection"])(
		"retires the previous Run's result while the selected Run's %s is pending",
		async (phase) => {
			const f = fixture(kind);
			render(f.view());
			await screen.findByText("Report first local");
			const pending = pendingResponse();
			if (phase === "inspection")
				f.invokeCommand.mockResolvedValueOnce(f.listReply());
			f.invokeCommand.mockImplementationOnce(() => pending.promise);
			fireEvent.click(screen.getByText(new Date(2000).toLocaleString()));
			await waitFor(() =>
				expect(f.calls(phase === "list" ? "list" : "inspect")).toHaveLength(2),
			);
			expect(screen.queryByText("Report first local")).toBeNull();
			if (kind === "graph") {
				expect(
					screen.queryByRole("button", { name: "Select step" }),
				).toBeNull();
				expect(screen.getByRole("status")).toBeTruthy();
			}
			await act(async () =>
				pending.resolve(
					phase === "list" ? f.listReply() : f.inspectReply("second"),
				),
			);
			expect(screen.getByText("Report second local")).toBeTruthy();
			expect(f.calls("inspect")).toHaveLength(2);
		},
	);

	it("retires a completed result when the backend authority changes", async () => {
		const f = fixture(kind);
		const { rerender } = render(f.view(local, "first"));
		await screen.findByText("Report first local");
		const pending = pendingResponse();
		f.invokeCommand.mockImplementationOnce(() => pending.promise);
		rerender(f.view(secondary, "first"));
		expect(screen.queryByText("Report first local")).toBeNull();
		await act(async () => pending.resolve(f.listReply(secondary)));
		expect(screen.getByText("Report first secondary")).toBeTruthy();
		expect(f.calls("inspect")[1][1].route).toEqual({
			kind: "exact",
			authority: secondary,
		});
	});

	it("preserves the surface's failure and selection policy while recovering", async () => {
		vi.useFakeTimers();
		const f = fixture(kind);
		await act(async () => {
			render(f.view());
		});
		f.invokeCommand
			.mockResolvedValueOnce(f.listReply())
			.mockRejectedValueOnce(new Error("inspection unavailable"));
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(Boolean(screen.queryByText("Report first local"))).toBe(
			kind === "schedule",
		);
		f.setIds(["second", "first"]);
		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: "Refresh" })),
		);
		expect(
			screen.getByText(`Report ${kind === "graph" ? "first" : "second"} local`),
		).toBeTruthy();
	});

	it.each(["success", "failure"])(
		"ignores a polling inspection's late %s after explicit selection",
		async (outcome) => {
			vi.useFakeTimers();
			const f = fixture(kind);
			await act(async () => {
				render(f.view());
			});
			const pending = pendingResponse();
			f.invokeCommand
				.mockResolvedValueOnce(f.listReply())
				.mockImplementationOnce(() => pending.promise);
			await act(async () => vi.advanceTimersByTimeAsync(5000));
			await act(async () =>
				fireEvent.click(screen.getByText(new Date(2000).toLocaleString())),
			);
			expect(screen.getByText("Report second local")).toBeTruthy();
			await act(async () => {
				if (outcome === "success") pending.resolve(f.inspectReply("first"));
				else pending.reject(new Error("retired polling inspection"));
			});
			expect(screen.getByText("Report second local")).toBeTruthy();
			expect(screen.queryByText("Report first local")).toBeNull();
		},
	);

	it("keeps a slow pane independent from another pane's reads and cleanup", async () => {
		const slow = fixture(kind);
		const fast = fixture(kind);
		const pending = pendingResponse();
		slow.invokeCommand.mockImplementationOnce(() => pending.promise);
		render(slow.view());
		const fastView = render(fast.view(secondary));
		await screen.findByText("Report first secondary");
		fastView.unmount();
		await act(async () => pending.resolve(slow.listReply()));
		expect(screen.getByText("Report first local")).toBeTruthy();
		expect(slow.calls("inspect")).toHaveLength(1);
	});
});

it("inspects the selected graph node and opens a fresh run without an old node request", async () => {
	const f = fixture("graph");
	const { rerender } = render(f.view(local, "first"));
	await screen.findByText("Report first local");
	fireEvent.click(screen.getByRole("button", { name: "Select step" }));
	await waitFor(() => expect(f.calls("inspect")).toHaveLength(2));
	expect(f.calls("inspect")[1][1].body.body).toMatchObject({
		runId: "first",
		nodeId: "collect",
	});
	rerender(f.view(local, "second"));
	await screen.findByText("Report second local");
	expect(f.calls("inspect")).toHaveLength(3);
	expect(f.calls("inspect")[2][1].body.body).toEqual({
		schemaVersion: 1,
		runId: "second",
	});
});

it("retires the previous graph when fresh Run navigation is waiting", async () => {
	const f = fixture("graph");
	const { rerender } = render(f.view(local, "first"));
	await screen.findByText("Report first local");
	const pending = pendingResponse();
	f.invokeCommand.mockImplementationOnce(() => pending.promise);
	rerender(f.view(local, "second"));
	expect(screen.queryByText("Report first local")).toBeNull();
	expect(screen.queryByRole("button", { name: "Select step" })).toBeNull();
	await act(async () => pending.resolve(f.listReply()));
	expect(screen.getByText("Report second local")).toBeTruthy();
});

it.each(["poll", "refresh", "node"])(
	"preserves the current graph during a pending same-Run %s",
	async (trigger) => {
		vi.useFakeTimers();
		const f = fixture("graph");
		await act(async () => {
			render(f.view());
		});
		const graphStep = screen.getByRole("button", { name: "Select step" });
		const pending = pendingResponse();
		f.invokeCommand
			.mockResolvedValueOnce(f.listReply())
			.mockImplementationOnce(() => pending.promise);
		await act(async () => {
			if (trigger === "poll") await vi.advanceTimersByTimeAsync(5000);
			else
				fireEvent.click(
					trigger === "node"
						? graphStep
						: screen.getByRole("button", { name: "Refresh" }),
				);
		});
		expect(f.calls("inspect")).toHaveLength(2);
		expect(screen.getByText("Report first local")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Select step" })).toBe(graphStep);
		await act(async () => pending.resolve(f.inspectReply("first")));
		expect(screen.getByRole("button", { name: "Select step" })).toBe(graphStep);
	},
);

it("preserves the graph when a refreshed authority describes the same backend", async () => {
	const f = fixture("graph");
	const { rerender } = render(f.view(local, "first"));
	await screen.findByText("Report first local");
	const graphStep = screen.getByRole("button", { name: "Select step" });
	const pending = pendingResponse();
	f.invokeCommand.mockImplementationOnce(() => pending.promise);
	rerender(f.view(structuredClone(local), "first"));
	expect(screen.getByText("Report first local")).toBeTruthy();
	expect(screen.getByRole("button", { name: "Select step" })).toBe(graphStep);
	await act(async () => pending.resolve(f.listReply()));
	expect(screen.getByRole("button", { name: "Select step" })).toBe(graphStep);
});

it("keeps the old graph retired after the selected Run fails and recovers on refresh", async () => {
	const f = fixture("graph");
	render(f.view());
	await screen.findByText("Report first local");
	const pending = pendingResponse();
	f.invokeCommand
		.mockResolvedValueOnce(f.listReply())
		.mockImplementationOnce(() => pending.promise);
	fireEvent.click(screen.getByText(new Date(2000).toLocaleString()));
	await waitFor(() => expect(f.calls("inspect")).toHaveLength(2));
	expect(screen.queryByText("Report first local")).toBeNull();
	await act(async () => pending.reject(new Error("selected Run unavailable")));
	expect(screen.getByRole("alert")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Select step" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	await screen.findByText("Report second local");
	expect(screen.queryByRole("alert")).toBeNull();
	expect(f.calls("inspect")[2][1].body.body.runId).toBe("second");
});
