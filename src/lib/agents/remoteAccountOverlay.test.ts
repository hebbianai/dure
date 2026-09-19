import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sshCopyAccount: vi.fn(),
	sshExecOnce: vi.fn(),
	sshPrepareAccountOverlay: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
	sshCopyAccount: mocks.sshCopyAccount,
	hostToOpts: vi.fn((host) => ({ host: host.host, user: host.user })),
	sshExecOnce: mocks.sshExecOnce,
	sshPrepareAccountOverlay: mocks.sshPrepareAccountOverlay,
}));

import {
	isRemoteCredentialUnavailable,
	preflightRemoteAccountLaunch,
	prepareRemoteAccountLogin,
} from "@/lib/agents/remoteAccountOverlay";
import type { AccountProfile, SshHostConfig } from "@/types";

const host: SshHostConfig = {
	id: "host-1",
	name: "remote",
	host: "example.test",
	port: 22,
	user: "tester",
	auth: "auto",
};

const account: AccountProfile = {
	id: "acc-work",
	provider: "claude",
	name: "work",
	dir: "/Users/test/.dure/accounts/claude-work",
};

beforeEach(() => {
	mocks.sshCopyAccount.mockReset().mockResolvedValue([".credentials.json"]);
	mocks.sshExecOnce.mockReset().mockResolvedValue({
		code: 0,
		stdout: "2.1.212 (Claude Code)",
		stderr: "",
	});
	mocks.sshPrepareAccountOverlay.mockReset().mockResolvedValue({
		remoteDirectory: ".dure/accounts/claude-work",
		credentialPresent: true,
	});
});

describe("remote account launch preflight", () => {
	it.skipIf(process.platform === "win32")(
		"finds a standalone provider outside the SSH login PATH",
		async () => {
			const home = mkdtempSync(join(tmpdir(), "dure-remote-provider-"));
			try {
				const bin = join(home, ".local/bin");
				mkdirSync(bin, { recursive: true });
				writeFileSync(
					join(bin, "codex"),
					"#!/bin/sh\nprintf 'codex-cli 0.155.1\\n'\n",
					{ mode: 0o700 },
				);
				mocks.sshExecOnce.mockImplementation(async (_host, command) => ({
					code: 0,
					stdout: execFileSync("/bin/sh", ["-c", command], {
						encoding: "utf8",
						env: { HOME: home, SHELL: "/bin/sh", PATH: "/usr/bin:/bin" },
					}),
					stderr: "",
				}));
				await expect(
					preflightRemoteAccountLaunch(host, "codex", home),
				).resolves.toEqual({ version: "" });
				expect(mocks.sshPrepareAccountOverlay).not.toHaveBeenCalled();
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	it.each(["claude", "codex"] as const)(
		"provisions the selected %s credential before returning a ready overlay",
		async (provider) => {
			const selected = {
				...account,
				provider,
				dir: `/Users/test/.dure/accounts/${provider}-work`,
			};
			mocks.sshPrepareAccountOverlay.mockRejectedValueOnce(
				"remote_credential_unavailable: remote profile has no credential",
			);
			let finishCopy!: () => void;
			mocks.sshCopyAccount.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						finishCopy = resolve;
					}),
			);
			const preflight = preflightRemoteAccountLaunch(
				host,
				provider,
				"/srv/repo",
				selected,
			);
			const result = preflight.then(
				(value) => ({ value }),
				(error) => ({ error }),
			);
			await vi.waitFor(() =>
				expect(mocks.sshCopyAccount).toHaveBeenCalledOnce(),
			);
			expect(mocks.sshCopyAccount).toHaveBeenCalledWith(
				{ host: "example.test", user: "tester" },
				provider,
				selected.dir,
				`.dure/accounts/${provider}-work`,
			);
			expect(mocks.sshPrepareAccountOverlay).toHaveBeenCalledOnce();
			finishCopy();
			expect(await result).toMatchObject({
				value: { overlay: { credentialPresent: true } },
			});
			expect(mocks.sshPrepareAccountOverlay).toHaveBeenCalledTimes(2);
			expect(mocks.sshPrepareAccountOverlay).toHaveBeenLastCalledWith(
				{ host: "example.test", user: "tester" },
				provider,
				`.dure/accounts/${provider}-work`,
				true,
			);
		},
	);

	it.each([
		[undefined, { remoteProfileDirectory: ".dure/accounts/claude-work" }],
		[account, { remoteProfileDirectory: ".dure/accounts/claude-other" }],
		[
			{ ...account, provider: "codex" as const },
			{ remoteProfileDirectory: ".dure/accounts/claude-work" },
		],
		[account, { requireCredential: false }],
	])(
		"never copies without an exact selected launch profile (%s, %s)",
		async (selected, options) => {
			const failure = new Error("remote_credential_unavailable: missing");
			mocks.sshPrepareAccountOverlay.mockRejectedValue(failure);
			await expect(
				preflightRemoteAccountLaunch(
					host,
					"claude",
					"/srv/repo",
					selected,
					options,
				),
			).rejects.toBe(failure);
			expect(mocks.sshCopyAccount).not.toHaveBeenCalled();
		},
	);

	it("preserves unrelated preparation errors without copying", async () => {
		const failure = new Error(
			"remote_credential_directory_untrusted: unsafe profile",
		);
		mocks.sshPrepareAccountOverlay.mockRejectedValue(failure);
		await expect(
			preflightRemoteAccountLaunch(host, "claude", "/srv/repo", account),
		).rejects.toBe(failure);
		expect(mocks.sshCopyAccount).not.toHaveBeenCalled();
	});

	it("refuses copying if caller authority changes during credential preparation", async () => {
		mocks.sshPrepareAccountOverlay.mockRejectedValueOnce({
			code: "remote_credential_unavailable",
		});
		const beforeOverlay = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValue(new Error("lease revoked"));
		await expect(
			preflightRemoteAccountLaunch(host, "claude", "/srv/repo", account, {
				beforeOverlay,
			}),
		).rejects.toThrow("lease revoked");
		expect(mocks.sshCopyAccount).not.toHaveBeenCalled();
	});

	it("preserves transfer failures without declaring the remote credential ready", async () => {
		mocks.sshPrepareAccountOverlay.mockRejectedValueOnce({
			code: "remote_credential_unavailable",
		});
		const failure = new Error(
			"credential_transfer_unavailable: missing local credential",
		);
		mocks.sshCopyAccount.mockRejectedValue(failure);
		await expect(
			preflightRemoteAccountLaunch(host, "claude", "/srv/repo", account),
		).rejects.toBe(failure);
		expect(mocks.sshPrepareAccountOverlay).toHaveBeenCalledOnce();
	});
	it.each(["codex", "claude"] as const)(
		"allows remote default-account %s without version diagnostics",
		async (provider) => {
			mocks.sshExecOnce.mockImplementation(async (_host, command: string) => ({
				code: command.includes("--version") ? 1 : 0,
				stdout: "",
				stderr: "",
			}));
			await expect(
				preflightRemoteAccountLaunch(host, provider, "/srv/repo"),
			).resolves.toEqual({ version: "" });
			expect(mocks.sshPrepareAccountOverlay).not.toHaveBeenCalled();
			expect(mocks.sshCopyAccount).not.toHaveBeenCalled();
		},
	);

	it("prepares remote Codex credentials without requiring a version command", async () => {
		mocks.sshExecOnce.mockImplementation(async (_host, command: string) => ({
			code: command.includes("--version") ? 1 : 0,
			stdout: "",
			stderr: "",
		}));
		const codex = {
			...account,
			provider: "codex" as const,
			dir: "/Users/test/.dure/accounts/codex-work",
		};
		await expect(
			preflightRemoteAccountLaunch(host, "codex", "/srv/repo", codex),
		).resolves.toMatchObject({ overlay: { credentialPresent: true } });
		expect(mocks.sshPrepareAccountOverlay).toHaveBeenCalledOnce();
		expect(mocks.sshCopyAccount).not.toHaveBeenCalled();
	});

	it("prepares login in the same profile without requiring or copying a credential", async () => {
		mocks.sshPrepareAccountOverlay.mockResolvedValue({
			credentialPresent: false,
		});
		await expect(
			prepareRemoteAccountLogin(host, "/srv/repo", account),
		).resolves.toBe(
			'env CLAUDE_CONFIG_DIR="$HOME/.dure/accounts/claude-work" claude auth login',
		);
		expect(mocks.sshPrepareAccountOverlay).toHaveBeenCalledWith(
			{ host: "example.test", user: "tester" },
			"claude",
			".dure/accounts/claude-work",
			false,
		);
		expect(mocks.sshCopyAccount).not.toHaveBeenCalled();
	});

	it("preserves a failed login preparation without starting a provider", async () => {
		const failure = new Error(
			"remote_credential_directory_untrusted: unsafe profile",
		);
		mocks.sshPrepareAccountOverlay.mockRejectedValue(failure);
		await expect(
			prepareRemoteAccountLogin(host, "/srv/repo", account),
		).rejects.toBe(failure);
	});

	it.each([
		[
			new Error(
				"remote_credential_unavailable: remote profile has no credential",
			),
			true,
		],
		[
			"Error: remote_credential_unavailable: remote profile has no credential",
			true,
		],
		[{ code: "remote_credential_unavailable" }, true],
		[new Error("remote_provider_preflight_failed: unavailable CLI"), false],
		["Permission denied (publickey)", false],
		[null, false],
	])(
		"offers credential login only for the adapter's missing-auth result (%s)",
		(error, expected) => {
			expect(isRemoteCredentialUnavailable(error)).toBe(expected);
		},
	);

	it("checks the provider/version before provisioning the reviewed overlay", async () => {
		const receipt = await preflightRemoteAccountLaunch(
			host,
			"claude",
			"/srv/repo",
			account,
			{ requireCredential: true },
		);

		expect(receipt.overlay?.credentialPresent).toBe(true);
		expect(mocks.sshExecOnce.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.sshPrepareAccountOverlay.mock.invocationCallOrder[0],
		);
		expect(mocks.sshExecOnce.mock.calls[0][1]).toContain(
			"cd '\\''/srv/repo'\\''",
		);
		expect(mocks.sshExecOnce.mock.calls[0][1]).toContain('"$remote_shell" -lc');
		expect(mocks.sshExecOnce.mock.calls[0][1]).not.toContain(" -lic ");
		expect(mocks.sshPrepareAccountOverlay).toHaveBeenCalledWith(
			{ host: "example.test", user: "tester" },
			"claude",
			".dure/accounts/claude-work",
			true,
		);
	});

	it("refuses an unreviewed Claude version before any remote mutation", async () => {
		mocks.sshExecOnce.mockResolvedValue({
			code: 0,
			stdout: "2.1.100 (Claude Code)",
			stderr: "",
		});

		await expect(
			preflightRemoteAccountLaunch(host, "claude", "/srv/repo", account),
		).rejects.toMatchObject({ code: "credential_overlay_version_unsupported" });
		expect(mocks.sshPrepareAccountOverlay).not.toHaveBeenCalled();
	});

	it("preflights an already-bound remote profile without a local account entry", async () => {
		await preflightRemoteAccountLaunch(host, "claude", "/srv/repo", undefined, {
			requireCredential: true,
			remoteProfileDirectory: ".dure/accounts/claude-work",
		});

		expect(mocks.sshPrepareAccountOverlay).toHaveBeenCalledWith(
			{ host: "example.test", user: "tester" },
			"claude",
			".dure/accounts/claude-work",
			true,
		);
	});

	it("does not provision when the remote provider probe fails", async () => {
		mocks.sshExecOnce.mockResolvedValue({
			code: 127,
			stdout: "",
			stderr: "claude: command not found",
		});

		await expect(
			preflightRemoteAccountLaunch(host, "claude", "/srv/repo", account),
		).rejects.toMatchObject({ code: "remote_provider_preflight_failed" });
		expect(mocks.sshPrepareAccountOverlay).not.toHaveBeenCalled();
	});

	it("checks the caller lease again after probing and before overlay mutation", async () => {
		const checkpoint = vi.fn(() => {
			throw new Error("client_agent_runtime_transition_conflict");
		});

		await expect(
			preflightRemoteAccountLaunch(host, "claude", "/srv/repo", account, {
				requireCredential: true,
				beforeOverlay: checkpoint,
			}),
		).rejects.toThrow("client_agent_runtime_transition_conflict");

		expect(mocks.sshExecOnce).toHaveBeenCalledOnce();
		expect(checkpoint).toHaveBeenCalledOnce();
		expect(mocks.sshPrepareAccountOverlay).not.toHaveBeenCalled();
	});

	it("awaits the exact-authority assertion before overlay mutation", async () => {
		let finishAssertion!: () => void;
		const beforeOverlay = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishAssertion = resolve;
				}),
		);

		const preflight = preflightRemoteAccountLaunch(
			host,
			"claude",
			"/srv/repo",
			account,
			{ requireCredential: true, beforeOverlay },
		);
		await vi.waitFor(() => expect(beforeOverlay).toHaveBeenCalledOnce());
		expect(mocks.sshPrepareAccountOverlay).not.toHaveBeenCalled();

		finishAssertion();
		await expect(preflight).resolves.toMatchObject({
			overlay: { credentialPresent: true },
		});
		expect(mocks.sshPrepareAccountOverlay).toHaveBeenCalledOnce();
	});
});
