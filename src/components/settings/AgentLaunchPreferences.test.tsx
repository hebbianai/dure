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
import { AgentLaunchPreferences } from "@/components/settings/AgentLaunchPreferences";
import { t } from "@/lib/i18n";
import { synchronizeProviderLaunchDefaults } from "@/lib/settings/providerLaunchDefaults";
import { useStore } from "@/store";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const mocks = vi.hoisted(() => ({ update: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/settings/providerLaunchDefaults", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/settings/providerLaunchDefaults")
	>()),
	updateProviderLaunchPermissionDefault: mocks.update,
}));
const document = {
	schemaVersion: 1 as const,
	revision: 1,
	defaults: {},
	fingerprint: `sha256:${"a".repeat(64)}`,
};
const label = () =>
	t("settings.general.providerSkipPermissions", { label: "Claude Code" });

afterEach(() => {
	cleanup();
	mocks.update.mockReset();
	mocks.invoke.mockReset();
	useStore.setState({
		skipPermissions: {},
		providerLaunchDefaults: null,
		providerLaunchDefaultsBackend: null,
		providerLaunchDefaultsProfileId: null,
		providerLaunchDefaultsError: null,
		legacySkipPermissions: undefined,
	});
});

describe("AgentLaunchPreferences", () => {
	it("recovers a failed initial load in place using the confirmed backend defaults", async () => {
		mocks.invoke.mockRejectedValueOnce({
			code: "provider_launch_defaults_unavailable",
		});
		await expect(synchronizeProviderLaunchDefaults()).rejects.toMatchObject({
			code: "provider_launch_defaults_unavailable",
		});
		mocks.invoke.mockClear();
		let finish = (_value: unknown) => {};
		mocks.invoke.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		render(<AgentLaunchPreferences />);
		const control = screen.getByRole("switch", {
			name: label(),
		}) as HTMLButtonElement;
		expect(control.disabled).toBe(true);
		expect(screen.getByRole("alert").textContent).toContain(
			t("settings.general.providerDefaults.failed"),
		);
		const retry = screen.getByRole("button", {
			name: t("common.retry"),
		}) as HTMLButtonElement;
		fireEvent.click(retry);
		expect(retry.disabled).toBe(true);
		expect(control.disabled).toBe(true);
		expect(control.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(retry);
		expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
			"dure_backend_request",
			{
				route: { kind: "selected", profileId: "local" },
				operation: "provider_launch_defaults.get",
				body: { schemaVersion: 1 },
			},
		);
		await act(async () => {
			finish({
				schemaVersion: 1,
				backendId: "local",
				backendGeneration: "generation-1",
				routeAuthority: testDureBackendRouteAuthority(
					"local",
					"generation-1",
					"local",
				),
				result: {
					schemaVersion: 1,
					document: {
						...document,
						defaults: { claude: { permissionMode: "bypass_approvals" } },
					},
				},
			});
		});
		await waitFor(() => expect(control.disabled).toBe(false));
		expect(control.getAttribute("aria-checked")).toBe("true");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			screen.queryByRole("button", { name: t("common.retry") }),
		).toBeNull();
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.invoke).toHaveBeenCalledTimes(1);
	});

	it("retains confirmed permissions and allows another retry if the reload fails", async () => {
		useStore.setState({
			providerLaunchDefaults: document,
			skipPermissions: { claude: true },
			providerLaunchDefaultsError: "provider_launch_defaults_unavailable",
		});
		mocks.invoke.mockRejectedValue({
			code: "provider_launch_defaults_unavailable",
		});
		render(<AgentLaunchPreferences />);
		const retry = screen.getByRole("button", {
			name: t("common.retry"),
		}) as HTMLButtonElement;
		const control = screen.getByRole("switch", {
			name: label(),
		}) as HTMLButtonElement;
		fireEvent.click(retry);
		expect(control.disabled).toBe(true);
		await waitFor(() => expect(retry.disabled).toBe(false));
		expect(control.disabled).toBe(false);
		expect(control.getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("alert").textContent).toContain(
			t("settings.general.providerDefaults.failed"),
		);
		fireEvent.click(retry);
		await waitFor(() => expect(retry.disabled).toBe(false));
		expect(mocks.invoke).toHaveBeenCalledTimes(2);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("waits for the backend permission default and retains the saved choice on remount", async () => {
		useStore.setState({
			skipPermissions: {},
			providerLaunchDefaults: document,
		});
		let finish = () => {};
		mocks.update.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const view = render(<AgentLaunchPreferences />);
		const control = screen.getByRole("switch", { name: label() });
		fireEvent.click(control);
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith("claude", true);
		expect((control as HTMLButtonElement).disabled).toBe(true);
		expect(control.getAttribute("aria-checked")).toBe("false");
		await act(async () => {
			useStore.setState({
				skipPermissions: { claude: true },
				providerLaunchDefaults: {
					...document,
					revision: 2,
					defaults: { claude: { permissionMode: "bypass_approvals" } },
				},
			});
			finish();
		});
		await waitFor(() =>
			expect((control as HTMLButtonElement).disabled).toBe(false),
		);
		view.unmount();
		render(<AgentLaunchPreferences />);
		expect(
			screen
				.getByRole("switch", { name: label() })
				.getAttribute("aria-checked"),
		).toBe("true");
	});

	it("keeps the previous permission value and shows the backend error when saving fails", async () => {
		useStore.setState({
			skipPermissions: { claude: true },
			providerLaunchDefaults: document,
		});
		mocks.update.mockImplementationOnce(async () => {
			useStore.setState({
				providerLaunchDefaultsError: "provider_launch_defaults_unavailable",
			});
			throw new Error("unavailable");
		});
		render(<AgentLaunchPreferences />);
		const control = screen.getByRole("switch", { name: label() });
		fireEvent.click(control);
		await waitFor(() =>
			expect((control as HTMLButtonElement).disabled).toBe(false),
		);
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith("claude", false);
		expect(control.getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("alert").textContent).toContain(
			t("settings.general.providerDefaults.failed"),
		);
	});
});
