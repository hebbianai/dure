export function developerIdTeam(identity) {
	return typeof identity === "string"
		? /^Developer ID Application: [^\r\n]+ \(([A-Z0-9]{10})\)$/.exec(identity)?.[1] ?? null
		: null;
}

/** Configuration readiness, not certificate import, signing or Apple acceptance.
 * Return only field names/booleans: never credentials or certificate material. */
export function inspectMacosSigning({
	identities,
	environment,
	apiKeyReadable,
}) {
	const has = (name) =>
		typeof environment[name] === "string" &&
		environment[name].trim().length > 0;
	const developerIds = [
		...identities.matchAll(
			/^\s*\d+\)\s+[0-9A-Fa-f]{40}\s+"(Developer ID Application: [^"]+)"\s*$/gm,
		),
	].map((match) => match[1]);
	const missing = [];
	const team = developerIdTeam(environment.APPLE_SIGNING_IDENTITY);
	if (!has("APPLE_SIGNING_IDENTITY")) missing.push("APPLE_SIGNING_IDENTITY");
	else if (!team || !developerIds.includes(environment.APPLE_SIGNING_IDENTITY))
		missing.push(
			"valid selected Developer ID Application identity in keychain",
		);
	const apiFields = ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"];
	const idFields = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
	const api = apiFields.every(has);
	const appleId = idFields.every(has);
	if (appleId && team && environment.APPLE_TEAM_ID !== team)
		missing.push("APPLE_TEAM_ID matching the selected Developer ID Application");
	if ("APPLE_CERTIFICATE" in environment || "APPLE_CERTIFICATE_PASSWORD" in environment)
		missing.push("remove automatic certificate import; provision the runner signing identity explicitly");
	if (!api && !appleId)
		missing.push(
			"complete App Store Connect API or Apple ID notarization credentials",
		);
	if (api && appleId)
		missing.push("one unambiguous notarization credential route");
	if ((apiFields.some(has) && !api) || (idFields.some(has) && !appleId))
		missing.push("remove or complete partial notarization credentials");
	if (api && !apiKeyReadable) missing.push("readable APPLE_API_KEY_PATH file");
	const updaterKeyConfigured = has("TAURI_SIGNING_PRIVATE_KEY");
	if (!updaterKeyConfigured) missing.push("TAURI_SIGNING_PRIVATE_KEY");
	return {
		ready: missing.length === 0,
		developerIdCount: developerIds.length,
		updaterKeyConfigured,
		notarizationRoute:
			api && !appleId ? "api" : appleId && !api ? "apple-id" : null,
		missing,
		artifactAcceptance:
			"pending: verify actual codesign, Gatekeeper and stapled notarization on built artifacts",
	};
}
