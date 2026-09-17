// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type {
	DurePluginCatalogEntry,
	DurePluginCatalogSnapshotV2,
} from "@/lib/plugins/durePlugins";

const mocks = vi.hoisted(() => ({ catalogV2: vi.fn() }));

vi.mock("@/lib/ipc", () => ({
	durePluginCatalogV2: mocks.catalogV2,
}));

import {
	resetPluginViewCatalogForTests,
	usePluginViewCatalog,
} from "@/components/plugins/usePluginViewCatalog";

const beads: DurePluginCatalogEntry = {
	manifest: {
		schema_version: 2,
		id: "dure.beads",
		publisher: "dure",
		version: "0.2.0",
		display_name: "Beads",
		host_api: { min_inclusive: 1, max_inclusive: 2 },
		contributions: [],
		agent_integrations: [],
	},
	compatibility: {
		status: "supported",
		negotiated_host_api_version: 2,
		contributions: [
			{
				id: "dure.beads.issue-tracker",
				family: "dure.issue-tracker",
				family_api_version: 1,
				placement: "workspace",
			},
			{
				id: "dure.beads.views",
				family: "dure.views",
				family_api_version: 1,
				placement: "ui",
			},
		],
		ignored_optional_contributions: [],
		enabled_agent_integrations: [],
		ignored_optional_agent_integrations: [],
	},
	distribution: "bundled",
	installed: true,
	removable: false,
	settings_contribution: null,
	issue_tracker_contributions: [
		{
			contribution_id: "dure.beads.issue-tracker",
			provider: {
				schema_version: 1,
				provider: "beads",
				operations: ["list"],
				prefer_repository_wrapper: false,
				repository_wrapper: null,
				agent_binding: null,
				mutation_delivery: null,
			},
		},
	],
	view_contributions: [
		{
			contribution_id: "dure.beads.views",
			views: {
				schema_version: 1,
				containers: [
					{
						id: "dure.beads.issues",
						location: "primary_sidebar",
						title: { default: "Beads" },
						icon: "list_todo",
					},
				],
				views: [
					{
						id: "dure.beads.issues.list",
						container_id: "dure.beads.issues",
						title: { default: "이슈" },
						kind: "issue_tracker",
						provider_contribution_id: "dure.beads.issue-tracker",
						default_query: "list",
						default_query_setting_key: null,
						watch_interval_setting_key: null,
						agent_claims: null,
					},
				],
			},
		},
	],
};

const mixedSnapshot: DurePluginCatalogSnapshotV2 = {
	schema_version: 2,
	outcomes: [
		{
			status: "available",
			identity: { source_id: "dure.bundled", candidate_id: "beads" },
			entry: beads,
		},
		{
			status: "rejected",
			identity: { source_id: "dure.installed", candidate_id: "broken" },
			manifest: null,
			reason: { kind: "source_rejected" },
		},
		{
			status: "conflict",
			plugin_id: "example.duplicate",
			candidates: [],
		},
	],
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function Probe() {
	const state = usePluginViewCatalog();
	return (
		<div>
			{state.catalog?.length ?? "loading"}:{state.containers.length}:
			{state.error ?? "none"}:{state.snapshot?.outcomes.length ?? "loading"}
		</div>
	);
}

afterEach(() => {
	cleanup();
	resetPluginViewCatalogForTests();
	vi.resetAllMocks();
});

it("keeps valid Beads views when sibling packages are rejected or conflicted", async () => {
	mocks.catalogV2.mockResolvedValue(mixedSnapshot);

	render(
		<StrictMode>
			<Probe />
			<Probe />
		</StrictMode>,
	);

	expect(await screen.findAllByText("1:1:none:3")).toHaveLength(2);
	expect(mocks.catalogV2).toHaveBeenCalledTimes(1);
});

it("isolates a reset catalog from an older pending request", async () => {
	const pending = deferred<DurePluginCatalogSnapshotV2>();
	const emptySnapshot: DurePluginCatalogSnapshotV2 = {
		schema_version: 2,
		outcomes: [],
	};
	mocks.catalogV2
		.mockReturnValueOnce(pending.promise)
		.mockResolvedValueOnce(emptySnapshot);

	const first = render(<Probe />);
	await vi.waitFor(() => expect(mocks.catalogV2).toHaveBeenCalledTimes(1));
	first.unmount();
	resetPluginViewCatalogForTests();
	render(<Probe />);
	expect(await screen.findByText("0:0:none:0")).toBeTruthy();

	pending.resolve(mixedSnapshot);
	await pending.promise;
	await Promise.resolve();

	expect(screen.getByText("0:0:none:0")).toBeTruthy();
	expect(screen.queryByText("1:1:none:3")).toBeNull();
	expect(mocks.catalogV2).toHaveBeenCalledTimes(2);
});
