// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setLang } from "@/lib/i18n";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { createGraphClient } from "@/lib/ipc/dureGraph";
import { createScheduleClient } from "@/lib/ipc/dureSchedule";
import { GraphEditor } from "./GraphEditor";

vi.mock("./GraphCanvas", () => ({ GraphCanvas: () => null }));
vi.mock("./useGraphLayout", () => ({
	useGraphLayout: () => ({ positions: {}, update: vi.fn() }),
}));
afterEach(() => {
	cleanup();
	setLang("ko");
});

it("keeps Command creation available when project discovery fails", async () => {
	setLang("en");
	const authority: DureBackendRouteAuthorityV1 = {
		schemaVersion: 1,
		profileId: "local",
		revision: `sha256:${"a".repeat(64)}`,
		backend: { id: "local", generation: "g1" },
		target: { source: "local", hostId: "local" },
	};
	const invokeCommand = vi.fn(
		async (_command: string, args: Record<string, unknown>) => {
			if (args.operation === "projects.list")
				throw new Error("Project discovery unavailable");
			const body = args.body as { method: string };
			return {
				schemaVersion: 1,
				routeAuthority: authority,
				backendId: "local",
				backendGeneration: "g1",
				result: {
					schemaVersion: 1,
					apiVersion: "dure.orchestration/v1",
					method: body.method,
					receipt: {
						schemaVersion: 1,
						...(body.method.endsWith("catalog")
							? {
									actions: [
										{
											action: { actionId: "command", version: 1 },
											inputs: {},
											outputs: {},
										},
									],
								}
							: { issues: [], order: [] }),
					},
				},
			};
		},
	);
	render(
		<GraphEditor
			client={createGraphClient({ invokeCommand })}
			scheduleClient={createScheduleClient({ invokeCommand })}
			authority={authority}
			pro
			onSaved={() => {}}
			onClose={() => {}}
		/>,
	);
	const command = await screen.findByRole("button", {
		name: "Command",
	});
	expect(command.hasAttribute("disabled")).toBe(false);
});

it("adopts the acknowledged draft before enabling Run even when JSON fields were reordered", async () => {
	setLang("en");
	const authority: DureBackendRouteAuthorityV1 = {
		schemaVersion: 1,
		profileId: "local",
		revision: `sha256:${"a".repeat(64)}`,
		backend: { id: "local", generation: "g1" },
		target: { source: "local", hostId: "local" },
	};
	const workflow = {
		schemaVersion: 1,
		workflowId: "daily",
		revision: 1,
		name: "Before",
		enabled: false,
		createdAtMs: 1,
		updatedAtMs: 1,
		trigger: { kind: "manual" },
		definition: {
			schemaVersion: 1,
			nodes: [
				{
					nodeId: "command",
					name: "Command",
					action: { actionId: "command", version: 1 },
					inputs: {
						script: { kind: "literal", value: "cat" },
						directory: { kind: "literal", value: "/tmp" },
					},
				},
			],
			edges: [],
		},
	};
	const invokeCommand = vi.fn(
		async (_command: string, args: Record<string, unknown>) => {
			const body = args.body as { method: string; body: object };
			let receipt: object = { issues: [], order: ["command"] };
			if (args.operation === "projects.list")
				return {
					schemaVersion: 1,
					routeAuthority: authority,
					backendId: "local",
					backendGeneration: "g1",
					result: { schemaVersion: 1, projects: [], complete: true },
				};
			if (body.method.endsWith("catalog"))
				receipt = {
					actions: [
						{
							action: { actionId: "command", version: 1 },
							inputs: {},
							outputs: {},
						},
					],
				};
			if (body.method.endsWith("show")) receipt = { workflow };
			if (body.method.endsWith("put")) {
				const definition = structuredClone(workflow.definition);
				definition.nodes[0].inputs = {
					directory: definition.nodes[0].inputs.directory,
					script: definition.nodes[0].inputs.script,
				};
				receipt = {
					workflow: { ...workflow, ...body.body, revision: 2, definition },
				};
			}
			return {
				schemaVersion: 1,
				routeAuthority: authority,
				backendId: "local",
				backendGeneration: "g1",
				result: {
					schemaVersion: 1,
					apiVersion: "dure.orchestration/v1",
					method: body.method,
					receipt: { schemaVersion: 1, ...receipt },
				},
			};
		},
	);
	render(
		<GraphEditor
			client={createGraphClient({ invokeCommand })}
			scheduleClient={createScheduleClient({ invokeCommand })}
			authority={authority}
			workflowId="daily"
			pro
			onSaved={() => {}}
			onClose={() => {}}
		/>,
	);
	const name = await screen.findByLabelText("Name", {});
	await waitFor(() => expect(name.hasAttribute("disabled")).toBe(false));
	fireEvent.change(name, { target: { value: "After" } });
	fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
	await screen.findByRole("heading", { name: "After" });
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Run" }).hasAttribute("disabled"),
		).toBe(false),
	);
	expect(
		screen.getByRole("button", { name: "Save draft" }).hasAttribute("disabled"),
	).toBe(true);
});
