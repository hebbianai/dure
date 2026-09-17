/** macOS Gatekeeper quarantine detection for freshly-updated provider CLIs.
 *
 * A brew-cask update installs a bare, notarized Mach-O binary carrying the
 * `com.apple.quarantine` attribute. When the app spawns it from a GUI context,
 * Gatekeeper blocks the standalone binary with a malware modal and SIGKILLs
 * it, so `--version` preflight fails.
 *
 * This module builds the read-only probe (attribute + signature, never the
 * binary itself) and the user-consented approve command. `signatureTrusted`
 * means the code signature chains to an Apple anchor (Developer ID or Apple),
 * which is the real Gatekeeper-trust question: a bare `codesign --verify` also
 * passes an ad-hoc or self-signed binary — exactly the untrusted code
 * Gatekeeper exists to stop — so the approve affordance is gated on the anchor
 * requirement, not on seal validity. The strip command re-checks the same
 * anchor at click time so a binary swapped after detection is not cleared. */

import { runShell } from "@/lib/ipc/process";

/** Rejects ad-hoc and self-signed code; passes Developer ID / Apple-signed. */
const APPLE_ANCHOR_REQUIREMENT = "anchor apple generic";

export interface QuarantineState {
	readonly quarantined: boolean;
	/** The signature chains to an Apple anchor (not merely internally intact). */
	readonly signatureTrusted: boolean;
	readonly signingIdentity: string | null;
}

export interface QuarantineDeps {
	runCommand?: typeof runShell;
}

function shellQuote(path: string): string {
	return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Read-only: attribute presence + Apple-anchored signature trust + identity.
 * Never executes the binary, so it does not itself trip the Gatekeeper modal. */
export function quarantineProbeCommand(path: string): string {
	const quoted = shellQuote(path);
	return [
		`xattr -p com.apple.quarantine ${quoted} >/dev/null 2>&1 && echo quarantined=1 || echo quarantined=0`,
		`codesign --verify -R='${APPLE_ANCHOR_REQUIREMENT}' --strict ${quoted} >/dev/null 2>&1 && echo signature=trusted || echo signature=untrusted`,
		`printf 'authority=%s\\n' "$(codesign -dvv ${quoted} 2>&1 | sed -n 's/^Authority=//p' | head -1)"`,
	].join("; ");
}

export function parseQuarantineState(stdout: string): QuarantineState {
	const line = (key: string): string | undefined => {
		for (const raw of stdout.split("\n")) {
			if (raw.startsWith(`${key}=`)) return raw.slice(key.length + 1);
		}
		return undefined;
	};
	const identity = line("authority")?.trim();
	return {
		quarantined: line("quarantined") === "1",
		signatureTrusted: line("signature") === "trusted",
		signingIdentity: identity ? identity : null,
	};
}

/** Re-verifies the Apple anchor at strip time (TOCTOU): a binary swapped
 * between detection and this call is not cleared unless it is still trusted. */
export function quarantineApproveCommand(path: string): string {
	const quoted = shellQuote(path);
	return `codesign --verify -R='${APPLE_ANCHOR_REQUIREMENT}' --strict ${quoted} && xattr -d com.apple.quarantine ${quoted}`;
}

/** Null when the probe command cannot run — an unknown state never offers an
 * approve affordance. */
export async function detectQuarantine(
	path: string,
	deps: QuarantineDeps = {},
): Promise<QuarantineState | null> {
	try {
		const result = await (deps.runCommand ?? runShell)(
			quarantineProbeCommand(path),
		);
		if (result.code !== 0) return null;
		return parseQuarantineState(result.stdout);
	} catch {
		return null;
	}
}
