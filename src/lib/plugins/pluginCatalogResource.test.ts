import { describe, expect, it, vi } from "vitest";
import type { DurePluginCatalogSnapshotV2 } from "@/lib/plugins/durePlugins";
import { createPluginCatalogResource } from "@/lib/plugins/pluginCatalogResource";

function catalogSnapshot(): DurePluginCatalogSnapshotV2 {
	return { schema_version: 2, outcomes: [] };
}

function availableCatalogSnapshot(): DurePluginCatalogSnapshotV2 {
	return {
		schema_version: 2,
		outcomes: [
			{
				status: "available",
				identity: { source_id: "dure.bundled", candidate_id: "beads" },
				entry: {
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
						contributions: [],
						ignored_optional_contributions: [],
						enabled_agent_integrations: [],
						ignored_optional_agent_integrations: [],
					},
					distribution: "bundled",
					installed: true,
					removable: false,
					settings_contribution: null,
					issue_tracker_contributions: [],
					view_contributions: [],
				},
			},
		],
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

describe("plugin catalog resource", () => {
	it("loads once when multiple subscribers mount", async () => {
		const snapshot = catalogSnapshot();
		const load = vi.fn().mockResolvedValue(snapshot);
		const resource = createPluginCatalogResource(load);
		const first = vi.fn();
		const second = vi.fn();
		resource.subscribe(first);
		resource.subscribe(second);

		resource.ensureLoaded();
		resource.ensureLoaded();
		await vi.waitFor(() =>
			expect(resource.getSnapshot().snapshot).toBe(snapshot),
		);

		expect(load).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalled();
		expect(second).toHaveBeenCalled();
	});

	it("recovers from an initial transient failure through refresh", async () => {
		const recovered = catalogSnapshot();
		const load = vi
			.fn()
			.mockRejectedValueOnce(new Error("catalog offline"))
			.mockResolvedValueOnce(recovered);
		const resource = createPluginCatalogResource(load);

		await resource.refresh();
		expect(resource.getSnapshot()).toMatchObject({
			snapshot: null,
			catalog: null,
			loadState: "error",
			error: "Error: catalog offline",
		});

		await resource.refresh();
		expect(resource.getSnapshot()).toMatchObject({
			snapshot: recovered,
			catalog: [],
			loadState: "ready",
			error: null,
		});
	});

	it("keeps the last successful snapshot when refresh fails", async () => {
		const available = availableCatalogSnapshot();
		const failure = deferred<DurePluginCatalogSnapshotV2>();
		const load = vi
			.fn()
			.mockResolvedValueOnce(available)
			.mockReturnValueOnce(failure.promise);
		const resource = createPluginCatalogResource(load);

		await resource.refresh();
		const lastGood = resource.getSnapshot();
		expect(lastGood.catalog).toHaveLength(1);
		const refreshRequest = resource.refresh();
		const refreshing = resource.getSnapshot();
		expect(refreshing.loadState).toBe("loading");
		expect(refreshing.snapshot).toBe(lastGood.snapshot);
		expect(refreshing.catalog).toBe(lastGood.catalog);
		expect(refreshing.containers).toBe(lastGood.containers);
		failure.reject(new Error("temporary failure"));
		await refreshRequest;

		const failedRefresh = resource.getSnapshot();
		expect(failedRefresh).toMatchObject({
			loadState: "error",
			error: "Error: temporary failure",
		});
		expect(failedRefresh.snapshot).toBe(lastGood.snapshot);
		expect(failedRefresh.catalog).toBe(lastGood.catalog);
		expect(failedRefresh.containers).toBe(lastGood.containers);
	});

	it("does not let an older request overwrite a newer refresh", async () => {
		const older = catalogSnapshot();
		const newer = catalogSnapshot();
		const first = deferred<DurePluginCatalogSnapshotV2>();
		const second = deferred<DurePluginCatalogSnapshotV2>();
		const load = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const resource = createPluginCatalogResource(load);

		const olderRequest = resource.refresh();
		const newerRequest = resource.refresh();
		second.resolve(newer);
		await newerRequest;
		first.resolve(older);
		await olderRequest;

		expect(resource.getSnapshot().snapshot).toBe(newer);
		expect(resource.getSnapshot().loadState).toBe("ready");
	});

	it("does not let an older failure replace a newer success", async () => {
		const newer = catalogSnapshot();
		const first = deferred<DurePluginCatalogSnapshotV2>();
		const second = deferred<DurePluginCatalogSnapshotV2>();
		const load = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const resource = createPluginCatalogResource(load);

		const olderRequest = resource.refresh();
		const newerRequest = resource.refresh();
		second.resolve(newer);
		await newerRequest;
		first.reject(new Error("stale failure"));
		await olderRequest;

		expect(resource.getSnapshot()).toMatchObject({
			snapshot: newer,
			loadState: "ready",
			error: null,
		});
	});

	it("keeps a newer failure authoritative over an older success", async () => {
		const older = availableCatalogSnapshot();
		const first = deferred<DurePluginCatalogSnapshotV2>();
		const second = deferred<DurePluginCatalogSnapshotV2>();
		const load = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const resource = createPluginCatalogResource(load);

		const olderRequest = resource.refresh();
		const newerRequest = resource.refresh();
		second.reject(new Error("newer failure"));
		await newerRequest;
		first.resolve(older);
		await olderRequest;

		expect(resource.getSnapshot()).toMatchObject({
			snapshot: null,
			catalog: null,
			loadState: "error",
			error: "Error: newer failure",
		});
	});
});
