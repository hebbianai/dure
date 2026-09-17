import { describe, expect, it, vi } from "vitest";
import {
	detectQuarantine,
	parseQuarantineState,
	quarantineApproveCommand,
	quarantineProbeCommand,
} from "@/lib/agents/providerCliQuarantine";

const CLAUDE = "/opt/homebrew/Caskroom/claude-code@latest/2.1.258/claude";

describe("quarantineProbeCommand", () => {
	it("shell-quotes the path and never executes the binary", () => {
		const command = quarantineProbeCommand(CLAUDE);
		expect(command).toContain(`'${CLAUDE}'`);
		// It reads attributes and the signature only — it must not run the binary.
		expect(command).toContain("xattr -p com.apple.quarantine");
		expect(command).toContain("codesign --verify");
		expect(command).not.toMatch(/--version/);
		// The path only ever appears as an argument to a reader, never in command
		// position (which would execute it).
		for (const occurrence of command.split(`'${CLAUDE}'`).slice(0, -1)) {
			expect(occurrence).toMatch(/(xattr|codesign) [^;]*$/);
		}
	});
	it("requires an Apple anchor, not merely a valid seal", () => {
		// A bare `codesign --verify` passes ad-hoc/self-signed binaries; the anchor
		// requirement is what makes "trusted" mean Gatekeeper-trusted.
		expect(quarantineProbeCommand(CLAUDE)).toContain(
			"-R='anchor apple generic'",
		);
	});
	it("escapes a single quote in the path", () => {
		expect(quarantineProbeCommand("/a'b/claude")).toContain(
			"'/a'\\''b/claude'",
		);
	});
});

describe("parseQuarantineState", () => {
	it("reads a quarantined, Apple-anchored binary with its identity", () => {
		expect(
			parseQuarantineState(
				"quarantined=1\nsignature=trusted\nauthority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)\n",
			),
		).toEqual({
			quarantined: true,
			signatureTrusted: true,
			signingIdentity: "Developer ID Application: Anthropic PBC (Q6L2SF6YDW)",
		});
	});
	it("treats an ad-hoc/untrusted signature as not trusted", () => {
		expect(
			parseQuarantineState("quarantined=1\nsignature=untrusted\nauthority=\n"),
		).toEqual({
			quarantined: true,
			signatureTrusted: false,
			signingIdentity: null,
		});
	});
	it("never lets a forged authority line spoof trust", () => {
		// The attacker-influenced Authority value can carry text, but it is always
		// on the `authority=` line and can never satisfy the `signature=` check.
		expect(
			parseQuarantineState(
				"quarantined=1\nsignature=untrusted\nauthority=signature=trusted\n",
			).signatureTrusted,
		).toBe(false);
	});
	it("reads an un-quarantined binary", () => {
		expect(
			parseQuarantineState("quarantined=0\nsignature=trusted\nauthority=X\n"),
		).toMatchObject({ quarantined: false });
	});
	it("treats missing or garbled output as not-quarantined, untrusted", () => {
		expect(parseQuarantineState("")).toEqual({
			quarantined: false,
			signatureTrusted: false,
			signingIdentity: null,
		});
	});
});

describe("quarantineApproveCommand", () => {
	it("re-verifies the Apple anchor before stripping quarantine (TOCTOU)", () => {
		expect(quarantineApproveCommand(CLAUDE)).toBe(
			`codesign --verify -R='anchor apple generic' --strict '${CLAUDE}' && xattr -d com.apple.quarantine '${CLAUDE}'`,
		);
	});
});

describe("detectQuarantine", () => {
	it("runs the probe command and parses the result", async () => {
		const runCommand = vi.fn(async () => ({
			stdout:
				"quarantined=1\nsignature=trusted\nauthority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)\n",
			stderr: "",
			code: 0,
		}));
		const state = await detectQuarantine("/path/claude", { runCommand });
		expect(runCommand).toHaveBeenCalledWith(
			quarantineProbeCommand("/path/claude"),
		);
		expect(state).toEqual({
			quarantined: true,
			signatureTrusted: true,
			signingIdentity: "Developer ID Application: Anthropic PBC (Q6L2SF6YDW)",
		});
	});
	it("returns null when the probe command itself fails", async () => {
		const runCommand = vi.fn(async () => ({
			stdout: "",
			stderr: "boom",
			code: 127,
		}));
		expect(await detectQuarantine("/path/claude", { runCommand })).toBeNull();
	});
});
