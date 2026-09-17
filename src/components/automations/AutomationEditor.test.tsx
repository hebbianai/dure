// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationEditor } from "@/components/automations/AutomationEditor";
import type { AutomationSchedule } from "@/lib/automations/scheduleContract";
import { setLang, t } from "@/lib/i18n";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { createScheduleClient } from "@/lib/ipc/dureSchedule";
import { chooseSelectValue, openSelect } from "@/test/select";

const authority: DureBackendRouteAuthorityV1 = {
	schemaVersion: 1,
	profileId: "local",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend-local", generation: "g1" },
	target: { source: "local", hostId: "local" },
};
const existing: AutomationSchedule = {
	schemaVersion: 1,
	scheduleId: "daily",
	revision: 4,
	name: "Review",
	enabled: true,
	expression: "0 9 * * 1-5",
	timezone: "UTC",
	createdAtMs: 1,
	updatedAtMs: 1,
	runTemplate: {
		projectId: "dure",
		providerId: "claude",
		prompt: "Review changes",
		model: "opus",
		effort: "high",
		permissionMode: "default",
		executionProfile: {
			kind: "credential_reference",
			reference_id: "cred_work",
			credential_generation: "g1",
		},
		worktree: { kind: "dedicated", baseCommitSha: "a".repeat(40) },
	},
};
function fixture({ loseFirstPut = false }: { loseFirstPut?: boolean } = {}) {
	let lost = false;
	let occurrence: Record<string, unknown> | undefined;
	const invokeCommand = vi.fn(
		async (_command: string, args: Record<string, unknown>) => {
			const body = args.body as Record<string, unknown>;
			let result: Record<string, unknown>;
			switch (args.operation) {
				case "projects.list":
					result = {
						complete: true,
						projects: [{ id: "dure", displayName: "Dure" }],
					};
					break;
				case "schedule.put": {
					if (loseFirstPut && !lost) {
						lost = true;
						throw new DureBackendRequestError("timeout", "Response lost", {
							kind: "transport",
						});
					}
					const { expectedRevision, idempotencyKey: _key, ...record } = body;
					result = {
						schedule: {
							...record,
							revision: Number(expectedRevision) + 1,
							createdAtMs: 1,
							updatedAtMs: 2,
						},
					};
					break;
				}
				case "schedule.run_once": {
					occurrence = {
						schemaVersion: 2,
						scheduleId: body.scheduleId,
						scheduleRevision: body.expectedRevision,
						trigger: { kind: "manual" },
						idempotencyKey: body.idempotencyKey,
						launchState: "started",
						operationId: "op-1",
						createdAtMs: 100,
						updatedAtMs: 101,
						run: {
							runId: "run-1",
							taskId: "task-1",
							dispatchId: "dispatch-1",
							generation: 1,
							workspaceId: "workspace-1",
							completed: true,
						},
					};
					result = { occurrence };
					break;
				}
				case "schedule.occurrences":
					result = { occurrences: occurrence ? [occurrence] : [] };
					break;
				case "schedule.inspect":
					result = {
						occurrence,
						resultMarkdown: "Reviewed the latest changes.",
					};
					break;
				default:
					throw new Error(`Unexpected operation: ${args.operation}`);
			}
			return {
				schemaVersion: 1,
				routeAuthority: authority,
				backendId: authority.backend.id,
				backendGeneration: authority.backend.generation,
				result: { schemaVersion: 1, ...result },
			};
		},
	);
	return { client: createScheduleClient({ invokeCommand }), invokeCommand };
}

describe("AutomationEditor", () => {
	beforeEach(() => setLang("en"));
	afterEach(() => {
		cleanup();
		setLang("ko");
	});

	it("creates a paused schedule, tests the saved configuration, and shows the retained report", async () => {
		const { client, invokeCommand } = fixture();
		const onSaved = vi.fn();
		render(
			<AutomationEditor
				client={client}
				authority={authority}
				pro
				onSaved={onSaved}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Morning review" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Agent/ }));
		openSelect(await screen.findByRole("combobox", { name: "Project" }));
		await screen.findByRole("option", { name: "Dure" });
		fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
		chooseSelectValue(screen.getByLabelText("Project"), "dure");
		chooseSelectValue(
			screen.getByLabelText(t("automations.provider")),
			"codex",
		);
		fireEvent.change(screen.getByLabelText("Model"), {
			target: { value: "gpt-6-astra" },
		});
		fireEvent.change(screen.getByLabelText("Reasoning effort"), {
			target: { value: "xhigh" },
		});
		fireEvent.change(screen.getByLabelText("Instructions"), {
			target: { value: "Review changes" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
		const put = invokeCommand.mock.calls.find(
			([, args]) => args.operation === "schedule.put",
		)?.[1];
		expect(put?.body).toMatchObject({
			name: "Morning review",
			enabled: false,
			expectedRevision: 0,
			runTemplate: {
				providerId: "codex",
				model: "gpt-6-astra",
				effort: "xhigh",
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Run" }));
		await screen.findByText("Reviewed the latest changes.");
		expect(
			screen.getByRole("heading", { name: "Report received" }),
		).toBeTruthy();
		const run = invokeCommand.mock.calls.find(
			([, args]) => args.operation === "schedule.run_once",
		)?.[1];
		expect(run?.body).toMatchObject({ expectedRevision: 1 });
		expect(run?.route).toEqual({ kind: "exact", authority });
	});

	it("retries an uncertain edit with the original payload and keeps credential and worktree identity", async () => {
		const { client, invokeCommand } = fixture({ loseFirstPut: true });
		const onSaved = vi.fn();
		render(
			<AutomationEditor
				client={client}
				authority={authority}
				schedule={existing}
				pro
				onSaved={onSaved}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Weekly review" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText("Response lost");
		expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(
			true,
		);
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
		const puts = invokeCommand.mock.calls.filter(
			([, args]) => args.operation === "schedule.put",
		);
		expect(puts).toHaveLength(2);
		expect(puts[1]).toEqual(puts[0]);
		expect(puts[0][1].body).toMatchObject({
			expectedRevision: 4,
			name: "Weekly review",
			runTemplate: existing.runTemplate,
		});
		expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
			"Weekly review",
		);
	});

	it("uses provider defaults after switching the provider of a saved schedule", async () => {
		const { client, invokeCommand } = fixture();
		const onSaved = vi.fn();
		const schedule: AutomationSchedule = {
			...existing,
			runTemplate: {
				...existing.runTemplate,
				executionProfile: { kind: "provider_default" },
			},
		};
		render(
			<AutomationEditor
				client={client}
				authority={authority}
				schedule={schedule}
				pro
				onSaved={onSaved}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Agent/ }));
		await waitFor(() =>
			expect(screen.getByLabelText("Model")).toHaveProperty("value", "opus"),
		);
		chooseSelectValue(
			screen.getByLabelText(t("automations.provider")),
			"codex",
		);
		expect(screen.getByLabelText("Model")).toHaveProperty("value", "");
		expect(screen.getByLabelText("Reasoning effort")).toHaveProperty(
			"value",
			"",
		);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
		const put = invokeCommand.mock.calls.find(
			([, args]) => args.operation === "schedule.put",
		)?.[1];
		expect(put?.body).toMatchObject({
			runTemplate: { providerId: "codex", model: undefined, effort: undefined },
		});
	});

	it("keeps results and pause available in Basic without exposing creation or manual runs", async () => {
		const { client, invokeCommand } = fixture();
		const onSaved = vi.fn();
		render(
			<AutomationEditor
				client={client}
				authority={authority}
				schedule={existing}
				pro={false}
				onSaved={onSaved}
				onClose={vi.fn()}
			/>,
		);
		await screen.findByText("No runs yet");
		expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Pause schedule" }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
		expect(
			invokeCommand.mock.calls.find(
				([, args]) => args.operation === "schedule.put",
			)?.[1].body,
		).toMatchObject({
			enabled: false,
			expectedRevision: 4,
			runTemplate: existing.runTemplate,
		});
	});

	it("keeps an unsaved draft until the user confirms closing", () => {
		const { client } = fixture();
		const onClose = vi.fn();
		render(
			<AutomationEditor
				client={client}
				authority={authority}
				pro
				onSaved={vi.fn()}
				onClose={onClose}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "New review" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
			"New review",
		);
	});

	it("opens the new test result after an older run was explicitly selected", async () => {
		const { client, invokeCommand } = fixture();
		render(
			<AutomationEditor
				client={client}
				authority={authority}
				schedule={existing}
				pro
				onSaved={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Run" }));
		await screen.findByText("Reviewed the latest changes.");
		fireEvent.click(
			screen.getByRole("button", { name: /Manual · Report received/ }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Run" }));
		await waitFor(() => {
			const starts = invokeCommand.mock.calls.filter(
				([, args]) => args.operation === "schedule.run_once",
			);
			expect(starts).toHaveLength(2);
			const inspections = invokeCommand.mock.calls.filter(
				([, args]) => args.operation === "schedule.inspect",
			);
			const latestBody = inspections[inspections.length - 1][1].body as Record<
				string,
				unknown
			>;
			const latestStart = starts[1][1].body as Record<string, unknown>;
			expect(latestBody.idempotencyKey).toBe(latestStart.idempotencyKey);
		});
	});
});
