// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurePluginSettingsDialog } from "@/components/sidebar/DurePluginSettingsDialog";
import type {
	DurePluginCatalogEntry,
	DurePluginSettingsSnapshot,
} from "@/lib/plugins/durePlugins";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
	durePluginSettingsGet: mocks.get,
	durePluginSettingsUpdate: mocks.update,
}));

vi.mock("@/components/plugins/PluginPermissionControls", () => ({
	PluginPermissionControls: () => null,
}));

const entry: DurePluginCatalogEntry = {
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
	settings_contribution: {
		target: {
			identity: {
				source_id: "dure.bundled",
				candidate_id: "dure.beads.bundled",
			},
			plugin_id: "dure.beads",
			version: "0.2.0",
			contribution_id: "dure.beads.settings",
		},
		contribution_id: "dure.beads.settings",
		schema: {
			schema_version: 1,
			settings: [
				{
					kind: "boolean",
					key: "workspace_toggle",
					title: "Workspace 토글",
					description: "Workspace별 테스트 토글",
					scope: "workspace",
					default: false,
				},
			],
		},
	},
	issue_tracker_contributions: [],
	view_contributions: [],
};

function snapshot(
	scope: "user" | "workspace",
	scopeKey: string | null,
	value = false,
): DurePluginSettingsSnapshot {
	return {
		target: entry.settings_contribution!.target,
		scope,
		scope_key: scopeKey,
		settings_revision: "0",
		values: scope === "workspace" ? { workspace_toggle: value } : {},
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

function mockSettingsReads() {
	mocks.get.mockImplementation(
		async (
			_target: DurePluginSettingsSnapshot["target"],
			scope: "user" | "workspace",
			scopeKey?: string,
			workspaceRoot?: string,
		) =>
			scope === "user"
				? snapshot("user", null)
				: snapshot(
						"workspace",
						scopeKey ?? workspaceRoot?.replace(/^\//, "") ?? null,
					),
	);
}

afterEach(async () => {
	const unmountFocus = screen.queryAllByRole("dialog").map((dialog) => {
		const received = vi.fn();
		dialog.addEventListener("focusScope.autoFocusOnUnmount", received, {
			once: true,
		});
		return received;
	});
	cleanup();
	try {
		// Radix defers unmount focus restoration to a timer. Finish it while
		// this jsdom realm still owns the dialog and its CustomEvent constructor.
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		});
		for (const received of unmountFocus) {
			expect(received).toHaveBeenCalledTimes(1);
		}
	} finally {
		vi.resetAllMocks();
	}
});

describe("DurePluginSettingsDialog", () => {
	it.each(["success", "failure"] as const)(
		"ignores a late workspace A update %s after switching to workspace B",
		async (outcome) => {
			const pending = deferred<DurePluginSettingsSnapshot>();
			mockSettingsReads();
			mocks.update
				.mockReturnValueOnce(pending.promise)
				.mockImplementation(async (next: DurePluginSettingsSnapshot) => next);
			const onOpenChange = vi.fn();
			const { rerender } = render(
				<DurePluginSettingsDialog
					entry={entry}
					open
					onOpenChange={onOpenChange}
					workspaceScopeKey="workspace-a"
					workspaceRoot="/workspace-a"
				/>,
			);

			const firstToggle = await screen.findByRole("switch", {
				name: "Workspace 토글",
			});
			expect(firstToggle.getAttribute("data-state")).toBe("unchecked");
			fireEvent.click(firstToggle);
			await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));

			rerender(
				<DurePluginSettingsDialog
					entry={entry}
					open
					onOpenChange={onOpenChange}
					workspaceScopeKey="workspace-b"
					workspaceRoot="/workspace-b"
				/>,
			);
			await waitFor(() =>
				expect(
					screen
						.getByRole("switch", { name: "Workspace 토글" })
						.getAttribute("data-state"),
				).toBe("unchecked"),
			);

			await act(async () => {
				if (outcome === "success") {
					pending.resolve(snapshot("workspace", "workspace-a", true));
				} else {
					pending.reject(new Error("late workspace A failure"));
				}
				await Promise.resolve();
			});

			const currentToggle = screen.getByRole("switch", {
				name: "Workspace 토글",
			});
			expect(currentToggle.getAttribute("data-state")).toBe("unchecked");
			expect(currentToggle.hasAttribute("disabled")).toBe(false);
			expect(screen.queryByRole("alert")).toBeNull();
			fireEvent.click(currentToggle);
			await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
			expect(mocks.update.mock.calls[1]?.[0]).toMatchObject({
				scope: "workspace",
				scope_key: "workspace-b",
				values: { workspace_toggle: true },
			});
			expect(mocks.update.mock.calls[1]?.[1]).toBe("/workspace-b");
		},
	);

	it("rejects a settings update response for a different target", async () => {
		mockSettingsReads();
		mocks.update.mockResolvedValue(
			snapshot("workspace", "other-workspace", true),
		);
		render(
			<DurePluginSettingsDialog
				entry={entry}
				open
				onOpenChange={vi.fn()}
				workspaceScopeKey="workspace-a"
			/>,
		);

		const toggle = await screen.findByRole("switch", {
			name: "Workspace 토글",
		});
		fireEvent.click(toggle);

		expect(
			await screen.findByText(
				/플러그인 설정 응답이 현재 대상과 일치하지 않습니다\./,
			),
		).toBeTruthy();
		expect(
			screen
				.getByRole("switch", { name: "Workspace 토글" })
				.getAttribute("data-state"),
		).toBe("unchecked");
	});

	it("treats an authoritative re-read of the requested value as a recovered commit", async () => {
		let workspaceReads = 0;
		mocks.get.mockImplementation(
			async (
				_target: DurePluginSettingsSnapshot["target"],
				scope: "user" | "workspace",
				_scopeKey?: string,
				workspaceRoot?: string,
			) => {
				if (scope === "user") return snapshot("user", null);
				workspaceReads += 1;
				return {
					...snapshot(
						"workspace",
						workspaceRoot?.replace(/^\//, "") ?? "workspace-a",
						workspaceReads > 1,
					),
					settings_revision: workspaceReads > 1 ? "1" : "0",
				};
			},
		);
		mocks.update.mockRejectedValue(new Error("response lost"));
		render(
			<DurePluginSettingsDialog
				entry={entry}
				open
				onOpenChange={vi.fn()}
				workspaceScopeKey="workspace-a"
				workspaceRoot="/workspace-a"
			/>,
		);

		const toggle = await screen.findByRole("switch", {
			name: "Workspace 토글",
		});
		fireEvent.click(toggle);
		await waitFor(() => expect(workspaceReads).toBe(2));
		expect(toggle.getAttribute("data-state")).toBe("checked");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("rejects settings read snapshots for a different plugin", async () => {
		mockSettingsReads();
		mocks.get.mockResolvedValueOnce({
			...snapshot("user", null),
			target: {
				...entry.settings_contribution!.target,
				plugin_id: "other.plugin",
			},
		});
		render(
			<DurePluginSettingsDialog
				entry={entry}
				open
				onOpenChange={vi.fn()}
				workspaceScopeKey="workspace-a"
			/>,
		);

		expect(
			await screen.findByText(
				/플러그인 설정 응답이 현재 대상과 일치하지 않습니다\./,
			),
		).toBeTruthy();
		expect(
			screen
				.getByRole("switch", { name: "Workspace 토글" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(mocks.update).not.toHaveBeenCalled();
	});
});
