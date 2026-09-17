import { describe, expect, it, vi } from "vitest";
import {
	type CliProjectRegistrationDependencies,
	handleCliProjectRegistration,
} from "@/lib/cli/cliProjectRegistration";

const project = {
	id: "proj-one",
	name: "plain",
	path: "/canonical/plain",
	kind: "local" as const,
	isRepo: false,
};
function harness() {
	const state = {
		activeSpaceId: "active",
		spaces: [
			{ id: "active", name: "Active" },
			{ id: "other", name: "Other" },
		],
		addLocalProject: vi.fn(async () => project),
		addRemoteProject: vi.fn(async () => ({
			...project,
			kind: "ssh" as const,
			sshHostId: "ssh-1",
		})),
	};
	const deps = {
		isMainWindow: () => true,
		claim: vi.fn(async () => true),
		state: () => state,
	} satisfies CliProjectRegistrationDependencies;
	return { state, deps };
}

describe("app project registration", () => {
	it("uses the GUI local add action and returns its canonical result after persistence", async () => {
		const { state, deps } = harness();
		const result = await handleCliProjectRegistration(
			{ path: "/linked/plain" },
			"one",
			deps,
		);
		expect(result).toEqual({
			ok: true,
			registration: {
				project,
				spaceId: "active",
				hostId: "local",
				scope: "app",
				persisted: true,
			},
		});
		expect(state.addLocalProject).toHaveBeenCalledExactlyOnceWith(
			"/linked/plain",
		);
		expect(state.addRemoteProject).not.toHaveBeenCalled();
	});

	it("keeps explicit Space as context and leaves registration in the remote GUI owner", async () => {
		const { state, deps } = harness();
		const result = await handleCliProjectRegistration(
			{ path: "C:\\plain", hostId: "ssh-1", spaceId: "other" },
			"remote",
			deps,
		);
		expect(result).toMatchObject({
			ok: true,
			registration: {
				spaceId: "other",
				hostId: "ssh-1",
				scope: "app",
				project: { kind: "ssh" },
			},
		});
		expect(state.addRemoteProject).toHaveBeenCalledExactlyOnceWith(
			"ssh-1",
			"C:\\plain",
		);
		expect(state.addLocalProject).not.toHaveBeenCalled();
		expect(state.activeSpaceId).toBe("active");
	});

	it.each([
		{ path: "" },
		{ path: "/plain", hostId: 1 },
		{ path: "/plain", spaceId: "missing" },
	])(
		"refuses malformed/unknown context before registration: %j",
		async (params) => {
			const { state, deps } = harness();
			expect(
				await handleCliProjectRegistration(params, "invalid", deps),
			).toMatchObject({ ok: false });
			expect(state.addLocalProject).not.toHaveBeenCalled();
			expect(state.addRemoteProject).not.toHaveBeenCalled();
		},
	);

	it("does not claim from a secondary window or repeat an already claimed write", async () => {
		const { state, deps } = harness();
		expect(
			await handleCliProjectRegistration({ path: "/plain" }, "one", {
				...deps,
				isMainWindow: () => false,
			}),
		).toBeNull();
		expect(deps.claim).not.toHaveBeenCalled();
		deps.claim.mockResolvedValue(false);
		expect(
			await handleCliProjectRegistration({ path: "/plain" }, "one", deps),
		).toBeNull();
		expect(state.addLocalProject).not.toHaveBeenCalled();
	});

	it("waits for the GUI registration owner and preserves its persistence failure", async () => {
		const { state, deps } = harness();
		let reject!: (error: Error) => void;
		let started!: () => void;
		const reconciling = new Promise<void>((resolve) => {
			started = resolve;
		});
		state.addLocalProject.mockImplementation(
			() =>
				new Promise((_resolve, rejectWrite) => {
					reject = rejectWrite;
					started();
				}),
		);
		let settled = false;
		const pending = handleCliProjectRegistration(
			{ path: "/plain" },
			"one",
			deps,
		).finally(() => {
			settled = true;
		});
		await reconciling;
		expect(settled).toBe(false);
		reject(new Error("disk unavailable"));
		expect(await pending).toMatchObject({
			ok: false,
			error: {
				message: "disk unavailable",
			},
		});
		expect(state.addLocalProject).toHaveBeenCalledOnce();
	});

	it("does not convert a remote inspection failure into a local registration", async () => {
		const { state, deps } = harness();
		state.addRemoteProject.mockRejectedValue(
			Object.assign(new Error("SSH authentication failed"), {
				code: "ssh_auth_failed",
			}),
		);
		expect(
			await handleCliProjectRegistration(
				{ path: "/remote", hostId: "ssh-1" },
				"one",
				deps,
			),
		).toEqual({
			ok: false,
			error: { code: "ssh_auth_failed", message: "SSH authentication failed" },
		});
		expect(state.addLocalProject).not.toHaveBeenCalled();
	});
});
