import { isRecord } from "@/lib/payloadGuards";

class CliSpaceIdentityError extends Error {
	readonly code = "invalid_request";

	constructor(message: string) {
		super(message);
		this.name = "CliSpaceIdentityError";
	}
}

function owns(value: Record<string, unknown>, key: string): boolean {
	return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

function identityValue(value: unknown, key: "spaceId" | "desktopId"): string {
	if (typeof value !== "string") {
		throw new CliSpaceIdentityError(`${key} must be a string`);
	}
	const normalized = value.trim();
	if (!normalized) {
		throw new CliSpaceIdentityError("spaceId is required");
	}
	return normalized;
}

/**
 * Resolves the canonical Space request identity. `desktopId` is a deprecated
 * input alias; equal dual fields are accepted for rolling upgrades, while a
 * conflict fails before any mutation.
 */
export function resolveCliSpaceId(
	params: Record<string, unknown>,
	options: { required?: boolean } = {},
): string | undefined {
	const hasSpaceId = owns(params, "spaceId");
	const hasDesktopId = owns(params, "desktopId");
	const spaceId = hasSpaceId
		? identityValue(params.spaceId, "spaceId")
		: undefined;
	const desktopId = hasDesktopId
		? identityValue(params.desktopId, "desktopId")
		: undefined;
	if (spaceId && desktopId && spaceId !== desktopId) {
		throw new CliSpaceIdentityError(
			"spaceId and desktopId must identify the same Space",
		);
	}
	const resolved = spaceId ?? desktopId;
	if (!resolved && options.required) {
		throw new CliSpaceIdentityError("spaceId is required");
	}
	return resolved;
}

export function cliSpaceIdentityErrorCode(error: unknown): string | undefined {
	return error instanceof CliSpaceIdentityError ? error.code : undefined;
}

/**
 * Adds canonical `spaceId` and an equal deprecated `desktopId` alias to every
 * JSON receipt identity. Canonical data wins if an internal producer supplied
 * conflicting fields, so the published receipt never exposes two authorities.
 */
export function projectCliSpaceReceipt(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(projectCliSpaceReceipt);
	if (!isRecord(value)) return value;
	const projected = Object.fromEntries(
		Object.entries(value).map(([key, member]) => [
			key,
			projectCliSpaceReceipt(member),
		]),
	);
	const canonical =
		typeof projected.spaceId === "string" && projected.spaceId.trim()
			? projected.spaceId.trim()
			: typeof projected.desktopId === "string" && projected.desktopId.trim()
				? projected.desktopId.trim()
				: undefined;
	if (canonical) {
		projected.spaceId = canonical;
		projected.desktopId = canonical;
	}
	return projected;
}
