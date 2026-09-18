import type { MobileDeviceTarget } from "@/lib/mobileSimulator/types";
import { readMobileDeviceTarget } from "./preview";

export interface MobileRunProfile {
	projectPath: string;
	buildCommand: string;
	artifactPath: string;
	appId: string;
	url: string;
	device: MobileDeviceTarget;
}
export function mobileRunProfileKey(
	profile: Pick<MobileRunProfile, "projectPath" | "device">,
): string {
	return JSON.stringify([
		profile.projectPath,
		profile.device.platform,
		profile.device.id,
	]);
}

export function readMobileRunProfiles(value: unknown): MobileRunProfile[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 16).flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const device = readMobileDeviceTarget(item.device);
		if (
			!device ||
			!["projectPath", "buildCommand", "artifactPath", "appId", "url"].every(
				(key) => typeof item[key] === "string" && item[key].length <= 8192,
			) ||
			!item.projectPath ||
			!item.appId
		)
			return [];
		return [
			{
				projectPath: item.projectPath,
				buildCommand: item.buildCommand,
				artifactPath: item.artifactPath,
				appId: item.appId,
				url: item.url,
				device,
			},
		];
	});
}
export function saveMobileRunProfile(
	profiles: MobileRunProfile[],
	next: MobileRunProfile,
): MobileRunProfile[] {
	return [
		...profiles.filter(
			(profile) => mobileRunProfileKey(profile) !== mobileRunProfileKey(next),
		),
		next,
	].slice(-16);
}
