// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AutomationsPane } from "@/components/automations/AutomationsPane";
import { setLang } from "@/lib/i18n";
import { useStore } from "@/store";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
	setLang("en");
	useStore.setState((state) => ({
		uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" },
	}));
});
afterEach(() => {
	cleanup();
	setLang("ko");
	vi.resetAllMocks();
});

it("keeps the opened editor on its original runtime when a refresh selects another profile", async () => {
	const route = {
		schemaVersion: 1,
		profileId: "local",
		revision: `sha256:${"a".repeat(64)}`,
		backend: { id: "backend-local", generation: "g1" },
		target: { source: "local", hostId: "local" },
	};
	const other = {
		...route,
		profileId: "secondary",
		backend: { id: "backend-secondary", generation: "g2" },
	};
	const schedule = {
		schemaVersion: 1,
		scheduleId: "daily",
		revision: 1,
		name: "Daily review",
		enabled: true,
		expression: "0 9 * * 1-5",
		timezone: "UTC",
		createdAtMs: 1,
		updatedAtMs: 1,
		runTemplate: {
			projectId: "dure",
			providerId: "claude",
			prompt: "Review",
			permissionMode: "default",
		},
	};
	let lists = 0;
	invoke.mockImplementation(async (_command, args) => {
		let authority = args.route.authority ?? route;
		let result: Record<string, unknown>;
		if (args.operation === "schedule.list") {
			authority = ++lists === 1 ? route : other;
			result = { schedules: lists === 1 ? [schedule] : [], complete: true };
		} else if (args.operation === "projects.list") {
			result = {
				projects: [{ id: "dure", displayName: "Dure" }],
				complete: true,
			};
		} else if (args.operation === "schedule.put") {
			const { expectedRevision, idempotencyKey: _key, ...body } = args.body;
			result = {
				schedule: {
					...body,
					revision: expectedRevision + 1,
					createdAtMs: 1,
					updatedAtMs: 2,
				},
			};
		} else throw new Error(`Unexpected operation: ${args.operation}`);
		return {
			schemaVersion: 1,
			backendId: authority.backend.id,
			backendGeneration: authority.backend.generation,
			routeAuthority: authority,
			result: { schemaVersion: 1, ...result },
		};
	});
	render(<AutomationsPane />);
	fireEvent.click(await screen.findByRole("button", { name: /Daily review/ }));
	fireEvent.change(screen.getByLabelText("Name"), {
		target: { value: "First edit" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await waitFor(() => expect(lists).toBe(2));
	await screen.findByRole("heading", { name: "First edit" });
	fireEvent.change(screen.getByLabelText("Name"), {
		target: { value: "Second edit" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await screen.findByRole("heading", { name: "Second edit" });
	const puts = invoke.mock.calls.filter(
		([, args]) => args.operation === "schedule.put",
	);
	expect(puts).toHaveLength(2);
	expect(puts.map(([, args]) => args.route)).toEqual([
		{ kind: "exact", authority: route },
		{ kind: "exact", authority: route },
	]);
});
