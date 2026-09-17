import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createSshHostDurably: vi.fn(),
	updateSshHostCredentialsDurably: vi.fn(),
}));

vi.mock("@/lib/ssh/sshCredentialLifecycle", () => ({
	createSshHostDurably: mocks.createSshHostDurably,
	updateSshHostCredentialsDurably: mocks.updateSshHostCredentialsDurably,
}));

import {
	registerSshConfigHostDurably,
	sshConfigRouteAdoptionUpdate,
} from "@/lib/ssh/sshConfigRouteLifecycle";
import type { SshConfigHostDraft } from "@/lib/ssh/sshConfigRegistration";
import type { SshHostConfig } from "@/types";

const draft: SshConfigHostDraft = {
	name: "gate",
	sshConfigAlias: "gate",
	host: "new-scan.example.test",
	port: 22,
	user: "scan-user",
	auth: "auto",
};

const passwordHost: SshHostConfig = {
	id: "host-1",
	registrationGeneration: "generation-1",
	name: "My gate",
	host: "saved.example.test",
	port: 2202,
	user: "saved-user",
	auth: "password",
	secretId: "legacy-password",
};

describe("SSH config route lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("preserves saved authentication while adopting provenance for a legacy row", () => {
		expect(sshConfigRouteAdoptionUpdate(passwordHost, draft)).toEqual({
			expected: passwordHost,
			next: {
				name: passwordHost.name,
				sshConfigAlias: draft.sshConfigAlias,
				host: passwordHost.host,
				port: passwordHost.port,
				user: passwordHost.user,
				auth: "password",
				keyPath: undefined,
			},
		});
	});

	it("treats an already-provenanced duplicate as a no-op", async () => {
		const established = { ...passwordHost, sshConfigAlias: draft.sshConfigAlias };
		mocks.createSshHostDurably.mockResolvedValue({
			host: established,
			created: false,
		});

		await expect(registerSshConfigHostDurably(draft)).resolves.toEqual({
			host: established,
			created: false,
		});
		expect(mocks.updateSshHostCredentialsDurably).not.toHaveBeenCalled();
	});

	it("routes only legacy provenance adoption through the durable lifecycle", async () => {
		const adopted = {
			...passwordHost,
			sshConfigAlias: draft.sshConfigAlias,
			registrationGeneration: "generation-2",
		};
		mocks.createSshHostDurably.mockResolvedValue({
			host: passwordHost,
			created: false,
		});
		mocks.updateSshHostCredentialsDurably.mockResolvedValue(adopted);

		await expect(registerSshConfigHostDurably(draft)).resolves.toEqual({
			host: adopted,
			created: false,
		});
		expect(mocks.updateSshHostCredentialsDurably).toHaveBeenCalledWith(
			sshConfigRouteAdoptionUpdate(passwordHost, draft),
		);
	});
});
