// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPreflight } from "@/lib/ipc";

const detectQuarantine = vi.fn();
const runShell = vi.fn();

vi.mock("@/lib/agents/providerCliQuarantine", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/agents/providerCliQuarantine")
	>()),
	detectQuarantine: (...args: unknown[]) => detectQuarantine(...args),
}));
vi.mock("@/lib/ipc/process", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/process")>()),
	runShell: (cmd: string) => runShell(cmd),
}));

import { ProviderCliQuarantineNotice } from "@/components/settings/ProviderCliQuarantineNotice";

const PATH = "/opt/homebrew/Caskroom/claude-code@latest/2.1.258/claude";
const APPROVE_CMD = `codesign --verify -R='anchor apple generic' --strict '${PATH}' && xattr -d com.apple.quarantine '${PATH}'`;
const SIGNED = {
	quarantined: true,
	signatureTrusted: true,
	signingIdentity: "Developer ID Application: Anthropic PBC (Q6L2SF6YDW)",
};

function preflight(
	overrides: Partial<ProviderPreflight> = {},
): ProviderPreflight {
	return {
		provider: "claude",
		command: "claude",
		ready: false,
		status: "version_failed",
		message: "… --version exited with signal: 9 (SIGKILL)",
		shell: "/bin/zsh",
		cwd: "/",
		environmentSource: "login_shell",
		symlinkChain: [],
		executable: true,
		versionTimeoutMs: 10_000,
		recoveryRequiresUserApproval: false,
		suggestedRecovery: [],
		resolvedPath: PATH,
		...overrides,
	};
}

function render_(
	overrides: Partial<ProviderPreflight> = {},
	refresh = vi.fn(async () => {}),
) {
	return render(
		<ProviderCliQuarantineNotice
			provider="claude"
			preflight={preflight(overrides)}
			refreshPreflight={refresh}
			platform="macos"
		/>,
	);
}

beforeEach(() => {
	detectQuarantine.mockReset();
	runShell.mockReset();
});
afterEach(cleanup);

describe("ProviderCliQuarantineNotice", () => {
	it("does not probe when the preflight is ready", async () => {
		const { container } = render_({ ready: true, status: "ready" });
		await Promise.resolve();
		expect(detectQuarantine).not.toHaveBeenCalled();
		expect(container.innerHTML).toBe("");
	});

	it("does not probe on a non-macOS platform", async () => {
		render(
			<ProviderCliQuarantineNotice
				provider="claude"
				preflight={preflight()}
				refreshPreflight={vi.fn()}
				platform="linux"
			/>,
		);
		await Promise.resolve();
		expect(detectQuarantine).not.toHaveBeenCalled();
	});

	it("does not probe when preflight failed for a non-kill reason", async () => {
		render_({ status: "not_found" });
		await Promise.resolve();
		expect(detectQuarantine).not.toHaveBeenCalled();
	});

	it("renders nothing when the killed binary is not quarantined", async () => {
		detectQuarantine.mockResolvedValue({
			quarantined: false,
			signatureTrusted: true,
			signingIdentity: "x",
		});
		const { container } = render_();
		await waitFor(() => expect(detectQuarantine).toHaveBeenCalledWith(PATH));
		await Promise.resolve();
		expect(container.innerHTML).toBe("");
	});

	it("renders nothing when detection returns null (unknown state)", async () => {
		detectQuarantine.mockResolvedValue(null);
		const { container } = render_();
		await waitFor(() => expect(detectQuarantine).toHaveBeenCalledWith(PATH));
		await Promise.resolve();
		expect(container.innerHTML).toBe("");
	});

	it("offers Approve with the identity and the verbatim command when quarantined and validly signed", async () => {
		detectQuarantine.mockResolvedValue(SIGNED);
		render_();
		expect(await screen.findByRole("button")).toBeTruthy();
		expect(screen.getByText(/Anthropic PBC/)).toBeTruthy();
		expect(screen.getByText(APPROVE_CMD)).toBeTruthy();
	});

	it("warns without an Approve button when the signature is untrusted (never bypasses)", async () => {
		detectQuarantine.mockResolvedValue({
			quarantined: true,
			signatureTrusted: false,
			signingIdentity: null,
		});
		const { container } = render_();
		await waitFor(() => expect(detectQuarantine).toHaveBeenCalled());
		await Promise.resolve();
		expect(screen.queryByRole("button")).toBeNull();
		expect(container.innerHTML).not.toBe("");
	});

	it("does not offer Approve for a trusted signature with no named identity", async () => {
		detectQuarantine.mockResolvedValue({
			quarantined: true,
			signatureTrusted: true,
			signingIdentity: null,
		});
		render_();
		await waitFor(() => expect(detectQuarantine).toHaveBeenCalled());
		await Promise.resolve();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("strips quarantine and refreshes the preflight on Approve", async () => {
		detectQuarantine.mockResolvedValue(SIGNED);
		runShell.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
		const refresh = vi.fn(async () => {});
		render_({}, refresh);
		fireEvent.click(await screen.findByRole("button"));
		await waitFor(() => expect(runShell).toHaveBeenCalledWith(APPROVE_CMD));
		await waitFor(() => expect(refresh).toHaveBeenCalledWith("claude"));
	});

	it("surfaces a failed Approve and does not refresh", async () => {
		detectQuarantine.mockResolvedValue(SIGNED);
		runShell.mockResolvedValue({
			stdout: "",
			stderr: "Operation not permitted",
			code: 1,
		});
		const refresh = vi.fn(async () => {});
		render_({}, refresh);
		fireEvent.click(await screen.findByRole("button"));
		await waitFor(() =>
			expect(screen.getByText(/Operation not permitted/)).toBeTruthy(),
		);
		expect(refresh).not.toHaveBeenCalled();
	});
});
