export const ONBOARDING_IMPORT_PANE_DRAG_TYPE =
	"application/x-dure-onboarding-import-pane-v1";

export interface OnboardingImportPaneDragPayload {
	schemaVersion: 1;
	paneKey: string;
	fromDesktopId: string;
}

const MAX_ID_LENGTH = 1024;

function boundedId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_ID_LENGTH
	);
}

export function serializeOnboardingImportPaneDrag(
	paneKey: string,
	fromDesktopId: string,
): string {
	return JSON.stringify({ schemaVersion: 1, paneKey, fromDesktopId });
}

export function parseOnboardingImportPaneDrag(
	raw: string,
): OnboardingImportPaneDragPayload | null {
	if (!raw.startsWith("{")) return null;
	try {
		const value = JSON.parse(raw) as Partial<OnboardingImportPaneDragPayload>;
		if (
			value.schemaVersion !== 1 ||
			!boundedId(value.paneKey) ||
			!boundedId(value.fromDesktopId)
		) {
			return null;
		}
		return {
			schemaVersion: 1,
			paneKey: value.paneKey,
			fromDesktopId: value.fromDesktopId,
		};
	} catch {
		return null;
	}
}
