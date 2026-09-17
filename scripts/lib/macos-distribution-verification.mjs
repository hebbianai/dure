import { spawnSync } from "node:child_process";
import { developerIdTeam } from "./macos-signing-readiness.mjs";
import { verifyMacosAppCode } from "./macos-executable-signing.mjs";

function systemCheck(stage, command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error || result.status !== 0) {
		throw new Error(
			`macos_distribution_${stage}_failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
		);
	}
	return `${result.stdout}\n${result.stderr}`;
}

/** Read-only Apple acceptance, separate from updater-archive signing.
 * Tauri notarizes/staples the app before packing it, then signs the DMG. */
export function verifyMacosDistribution(assets, identity, check = systemCheck) {
	const team = developerIdTeam(identity);
	if (!team) throw new Error("macos_distribution_developer_id_required");
	// Apple TN3127: bind the Apple-issued Developer ID leaf to the selected team.
	const requirement = `=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
	verifyMacosAppCode(assets.app, identity, check);
	check("app_ticket", "xcrun", ["stapler", "validate", assets.app]);
	check("app_gatekeeper", "spctl", [
		"--assess", "--type", "execute", "--verbose=2", assets.app,
	]);
	check("dmg_signature", "codesign", [
		"--verify", "--strict", "--test-requirement", requirement, assets.dmg,
	]);
	return Object.freeze({ appSignature: true, hardenedRuntime: true, appTicket: true, gatekeeper: true, dmgSignature: true });
}
