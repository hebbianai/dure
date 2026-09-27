import type {
	MobileCapability,
	MobileDevice,
	MobileDeviceTarget,
} from "./types";

export function isIosSimulator(target: MobileDeviceTarget | null): boolean {
	return target?.platform === "ios" && target.transport === undefined;
}

/** Older desktop catalogs predate capabilities; only their original SDK targets
 * receive the original defaults. New transports must declare every operation. */
export function mobileCapabilities(
	device: MobileDevice | undefined,
): readonly MobileCapability[] {
	if (!device) return [];
	if (device.capabilities) return device.capabilities;
	if (device.transport) return [];
	return device.platform === "ios"
		? [
				"capture",
				"live",
				"boot",
				"open_native",
				"open_url",
				"install",
				"launch",
				"gesture",
				"type",
				"paste",
				"rotate",
				"home",
				"run",
			]
		: [
				"capture",
				"open_url",
				"install",
				"launch",
				"gesture",
				"type",
				"key",
				"rotate",
				"home",
				"back",
				"recents",
				"run",
			];
}
