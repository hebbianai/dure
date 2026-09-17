import {
	systemHardwareProfile,
	type SystemHardwareProfile,
} from "@/lib/ipc";
import type { WorkspaceHardwareProfile } from "@/lib/workspace/performance/workspaceCachePolicy";

let nativeProfilePromise: Promise<SystemHardwareProfile | null> | undefined;

function normalizeLogicalCores(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value >= 1
		? Math.floor(value)
		: undefined;
}

function normalizePhysicalMemoryBytes(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

/**
 * Read host capacity from the native adapter. WKWebView may privacy-cap or omit
 * browser hardware hints, so cache sizing must not infer the physical machine
 * solely from navigator.hardwareConcurrency/deviceMemory.
 */
export function readSystemHardwareProfile(
	refresh = false,
): Promise<SystemHardwareProfile | null> {
	if (refresh || !nativeProfilePromise) {
		nativeProfilePromise = systemHardwareProfile()
			.then((profile) => ({
				logicalCores: normalizeLogicalCores(profile.logicalCores),
				physicalMemoryBytes: normalizePhysicalMemoryBytes(
					profile.physicalMemoryBytes,
				),
			}))
			.catch(() => null);
	}
	return nativeProfilePromise;
}

/** Native cores are authoritative; browser memory remains an optional hint. */
export function mergeWorkspaceHardwareProfiles(
	browser: WorkspaceHardwareProfile,
	native: SystemHardwareProfile | null,
): WorkspaceHardwareProfile {
	return {
		logicalCores: native?.logicalCores ?? browser.logicalCores,
		deviceMemoryGb: browser.deviceMemoryGb,
		physicalMemoryBytes: native?.physicalMemoryBytes,
	};
}
