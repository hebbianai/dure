import { expect, test } from "vitest";
import { inspectMacosSigning } from "./lib/macos-signing-readiness.mjs";

const identity = "Developer ID Application: Fixture (TEAM123456)";
const identities =
	"  1) " + "A".repeat(40) + ' "' + identity + '"\n  1 valid identities found';
const environment = {
	APPLE_SIGNING_IDENTITY: identity,
	APPLE_ID: "PRIVATE-ACCOUNT",
	APPLE_PASSWORD: "PRIVATE-PASSWORD",
	APPLE_TEAM_ID: "TEAM123456",
	TAURI_SIGNING_PRIVATE_KEY: "PRIVATE-KEY",
};

test("distinguishes distribution signing from development and updater signing", () => {
	const result = inspectMacosSigning({
		identities: identities.replaceAll(
			"Developer ID Application",
			"Apple Development",
		),
		environment: {
			...environment,
			APPLE_SIGNING_IDENTITY: "Apple Development: Fixture (TEAM123456)",
		},
	});
	expect(result.ready).toBe(false);
	expect(result.developerIdCount).toBe(0);
	expect(result.updaterKeyConfigured).toBe(true);
});
test("reports configuration readiness without claiming artifact acceptance or exposing credentials", () => {
	const result = inspectMacosSigning({ identities, environment });
	expect(result.ready).toBe(true);
	expect(result.artifactAcceptance).toContain("pending");
	expect(JSON.stringify(result)).not.toContain("PRIVATE-");
	expect(JSON.stringify(result)).not.toContain(identity);
});
test.each([
	{ APPLE_PASSWORD: "" },
	{ TAURI_SIGNING_PRIVATE_KEY: "" },
	{ APPLE_SIGNING_IDENTITY: "-" },
	{ APPLE_API_KEY: "partial-route" },
	{
		APPLE_API_ISSUER: "issuer",
		APPLE_API_KEY: "key",
		APPLE_API_KEY_PATH: "private-key",
	},
])("refuses incomplete or ambiguous signing configuration: %s", (change) => {
	expect(
		inspectMacosSigning({
			identities,
			environment: { ...environment, ...change },
			apiKeyReadable: true,
		}).ready,
	).toBe(false);
});
test("requires a readable API key file without opening its contents", () => {
	const api = {
		APPLE_SIGNING_IDENTITY: identity,
		APPLE_API_ISSUER: "issuer",
		APPLE_API_KEY: "key",
		APPLE_API_KEY_PATH: "private-key",
		TAURI_SIGNING_PRIVATE_KEY: "PRIVATE",
	};
	expect(
		inspectMacosSigning({ identities, environment: api, apiKeyReadable: false })
			.ready,
	).toBe(false);
	expect(
		inspectMacosSigning({ identities, environment: api, apiKeyReadable: true })
			.ready,
	).toBe(true);
});

test.each([
	{ APPLE_TEAM_ID: "OTHER12345" },
	{ APPLE_CERTIFICATE: "PRIVATE-CERTIFICATE" },
	{ APPLE_CERTIFICATE_PASSWORD: "PRIVATE-CERTIFICATE-PASSWORD" },
	{ APPLE_CERTIFICATE: "" },
	{ APPLE_CERTIFICATE_PASSWORD: "" },
])("refuses mismatched teams and implicit shared-keychain imports", (change) => {
	const result = inspectMacosSigning({
		identities,
		environment: { ...environment, ...change },
	});
	expect(result.ready).toBe(false);
	expect(JSON.stringify(result)).not.toContain("PRIVATE-");
});
