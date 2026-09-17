import { isDureDomainIdV1 } from "./protocol-identity.mjs";

const asRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

export function isBrowserProfileLabel(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		new TextEncoder().encode(value).length <= 512 &&
		!/\p{Cc}/u.test(value)
	);
}

/** Saved settings describe storage choices, never a running page or a lease. */
export function parseBrowserProfile(value) {
	const record = asRecord(value);
	const profile = asRecord(record?.profile);
	if (
		!record ||
		!profile ||
		!isDureDomainIdV1(profile.profileId) ||
		!isBrowserProfileLabel(profile.label) ||
		(profile.scope !== "default" &&
			profile.scope !== "isolated" &&
			profile.scope !== "imported") ||
		(profile.profileId === "default") !== (profile.scope === "default") ||
		(profile.userAgentMode !== "clean" && profile.userAgentMode !== "native") ||
		(record.state !== "active" &&
			record.state !== "retiring" &&
			record.state !== "deleted")
	)
		return undefined;
	return {
		profile: {
			profileId: profile.profileId,
			label: profile.label,
			scope: profile.scope,
			userAgentMode: profile.userAgentMode,
		},
		state: record.state,
	};
}

export function parseBrowserProfiles(value) {
	const rows = asRecord(value)?.profiles;
	if (!Array.isArray(rows)) return undefined;
	const identities = new Set();
	const result = [];
	for (const row of rows) {
		const record = parseBrowserProfile(row);
		if (!record || identities.has(record.profile.profileId)) return undefined;
		identities.add(record.profile.profileId);
		result.push(record);
	}
	return result;
}
