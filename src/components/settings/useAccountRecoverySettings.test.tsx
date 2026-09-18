// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RecoverySettingsSnapshot } from "@/lib/ipc/dureAccountRecovery";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { useAccountRecoverySettings } from "./useAccountRecoverySettings";
import { AccountRecoverySettings } from "./AccountRecoverySettings";
import { setLang } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	put: vi.fn(),
	register: vi.fn(),
	profiles: vi.fn(),
	state: {
		accounts: [
			{
				id: "personal",
				name: "Personal",
				provider: "codex",
				dir: "/fixture/accounts/codex-personal",
			},
		],
	},
}));
vi.mock("@/store", () => ({
	useStore: (selector: (state: typeof mocks.state) => unknown) =>
		selector(mocks.state),
}));
vi.mock("@/lib/ipc/dureAccountRecovery", () => ({
	createAccountRecoveryClient: (backendId: string) => ({
		get: (providerId: string, authority?: unknown) =>
			mocks.get(backendId, providerId, authority),
		put: mocks.put,
	}),
}));
vi.mock("@/lib/ipc/dureBackendProfiles", () => ({
	listDureBackendProfiles: mocks.profiles,
}));
vi.mock("@/lib/ipc/dureProviderCredentialProfile", () => ({
	registerDureProviderCredentialProfile: mocks.register,
}));

function snapshot(
	backend = "local",
	providerId = "codex",
): RecoverySettingsSnapshot {
	return {
		providerId,
		policy: null,
		profiles: [],
		routeAuthority: testDureBackendRouteAuthority(
			backend,
			"generation-1",
			backend,
		),
	};
}
beforeEach(() => {
	setLang("en");
	vi.clearAllMocks();
	mocks.profiles.mockResolvedValue([
		{ id: "local", kind: "local", default: true },
		{ id: "team", kind: "ssh", default: false },
	]);
	mocks.get.mockImplementation(async (backend, provider) =>
		snapshot(backend, provider),
	);
	mocks.put.mockImplementation(async (request) => ({
		schemaVersion: 1,
		...request,
		revision: request.expectedRevision + 1,
		activatedAtMs: request.enabled ? 123 : null,
		updatedAtMs: 123,
	}));
	mocks.register.mockResolvedValue({
		kind: "credential_reference",
		reference_id: "personal",
		credential_generation: "generation-personal",
	});
});
afterEach(cleanup);

it("edits the viewed server's allowed account order without selecting or copying personal accounts", async () => {
	const authority = snapshot("team").routeAuthority;
	const profiles = ["one", "two"].map((referenceId) => ({
		schemaVersion: 1,
		providerId: "codex",
		referenceId,
		credentialGeneration: "generation-1",
	}));
	mocks.get.mockResolvedValue({ ...snapshot("team"), profiles });
	const view = render(<AccountRecoverySettings authority={authority} />);
	fireEvent.click(await screen.findByRole("checkbox", { name: "one" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "two" }));
	view.rerender(<AccountRecoverySettings authority={structuredClone(authority)} />);
	expect(mocks.get).toHaveBeenCalledOnce();
	fireEvent.click(screen.getByRole("button", { name: "Move two up" }));
	fireEvent.click(screen.getByRole("switch"));
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
	await waitFor(() => expect(mocks.put).toHaveBeenCalledOnce());
	expect(mocks.get).toHaveBeenCalledWith("team", "codex", authority);
	expect(mocks.profiles).not.toHaveBeenCalled();
	expect(mocks.register).not.toHaveBeenCalled();
	expect(mocks.put.mock.calls[0][0]).toMatchObject({
		enabled: true,
		accounts: [{ profile: profiles[1] }, { profile: profiles[0] }],
	});
	expect(mocks.put.mock.calls[0][1]).toEqual(authority);
});

it("only offers personal accounts after explicit selection and save on the local server", async () => {
	const view = renderHook(useAccountRecoverySettings);
	await waitFor(() => expect(view.result.current.ready).toBe(true));
	expect(view.result.current.options).toEqual([
		{ id: "personal", name: "Personal" },
	]);
	expect(view.result.current.selected).toEqual([]);
	expect(mocks.register).not.toHaveBeenCalled();
	expect(mocks.put).not.toHaveBeenCalled();
	act(() => {
		view.result.current.setSelected(["personal"]);
		view.result.current.setEnabled(true);
	});
	expect(mocks.register).not.toHaveBeenCalled();
	await act(async () => view.result.current.save());
	expect(mocks.register).toHaveBeenCalledExactlyOnceWith(
		{
			providerId: "codex",
			referenceId: "personal",
			profileDirectoryName: "codex-personal",
		},
		{ profileId: "local", routeAuthority: snapshot().routeAuthority },
	);
	expect(mocks.put).toHaveBeenCalledWith(
		expect.objectContaining({
			providerId: "codex",
			expectedRevision: 0,
			enabled: true,
			accounts: [
				{
					profile: {
						schemaVersion: 1,
						providerId: "codex",
						referenceId: "personal",
						credentialGeneration: "generation-personal",
					},
					name: "Personal",
				},
			],
		}),
		snapshot().routeAuthority,
	);
});

it("joining a remote server neither lists nor copies personal credentials", async () => {
	const profile = {
		schemaVersion: 1 as const,
		providerId: "codex",
		referenceId: "shared",
		credentialGeneration: "server-generation",
	};
	mocks.get.mockImplementation(async (backend, provider) => ({
		...snapshot(backend, provider),
		profiles: backend === "team" ? [profile] : [],
	}));
	const view = renderHook(useAccountRecoverySettings);
	await waitFor(() => expect(view.result.current.ready).toBe(true));
	act(() => view.result.current.setBackendId("team"));
	await waitFor(() => expect(view.result.current.ready).toBe(true));
	expect(view.result.current.options).toEqual([
		{ id: "shared", name: "shared" },
	]);
	expect(mocks.register).not.toHaveBeenCalled();
	act(() => {
		view.result.current.setSelected(["shared"]);
		view.result.current.setEnabled(true);
	});
	await act(async () => view.result.current.save());
	expect(mocks.register).not.toHaveBeenCalled();
	expect(mocks.put).toHaveBeenCalledWith(
		expect.objectContaining({ accounts: [{ profile, name: "shared" }] }),
		snapshot("team").routeAuthority,
	);
});

it("does not save an old server snapshot while the newly selected server is loading", async () => {
	let resolve!: (next: RecoverySettingsSnapshot) => void;
	mocks.get.mockImplementation((backend, provider) =>
		backend === "team"
			? new Promise<RecoverySettingsSnapshot>((finish) => {
					resolve = finish;
				})
			: Promise.resolve(snapshot(backend, provider)),
	);
	const view = renderHook(useAccountRecoverySettings);
	await waitFor(() => expect(view.result.current.ready).toBe(true));
	act(() => view.result.current.setBackendId("team"));
	expect(view.result.current.ready).toBe(false);
	await act(async () => view.result.current.save());
	expect(mocks.put).not.toHaveBeenCalled();
	await act(async () => resolve(snapshot("team")));
	expect(view.result.current.ready).toBe(true);
});

it("keeps a policy conflict visible without retrying the write", async () => {
	mocks.put.mockRejectedValueOnce(new Error("provider_recovery_conflict"));
	const view = renderHook(useAccountRecoverySettings);
	await waitFor(() => expect(view.result.current.ready).toBe(true));
	await act(async () => view.result.current.save());
	expect(view.result.current.error).toContain("provider_recovery_conflict");
	expect(mocks.put).toHaveBeenCalledOnce();
});
