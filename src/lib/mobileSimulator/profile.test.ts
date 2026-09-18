import { describe, expect, it } from "vitest";
import { readMobileRunProfiles, saveMobileRunProfile } from "./profile";

const ios = {
	projectPath: "/project",
	buildCommand: "pnpm build:ios",
	artifactPath: "Build.app",
	appId: "com.dure.qa",
	url: "qa://home",
	device: { platform: "ios", id: "phone-one" },
} as const;
const android = {
	...ios,
	buildCommand: "pnpm build:android",
	artifactPath: "app.apk",
	device: { platform: "android", id: "emulator-5554" },
} as const;

describe("mobile run profile storage", () => {
	it("preserves one project's iOS and Android configurations across restoration", () => {
		const profiles = saveMobileRunProfile([ios], android);
		expect(readMobileRunProfiles(JSON.parse(JSON.stringify(profiles)))).toEqual(
			[ios, android],
		);
	});
	it("updates only the exact device, preserving other devices on the same platform", () => {
		const secondPhone = { ...ios, device: { ...ios.device, id: "phone-two" } };
		const original = [ios, android, secondPhone];
		const updated = { ...ios, buildCommand: "pnpm build:debug" };
		expect(saveMobileRunProfile(original, updated)).toEqual([
			android,
			secondPhone,
			updated,
		]);
		expect(original).toEqual([ios, android, secondPhone]);
	});
	it("distinguishes equal device IDs on different platforms", () => {
		const sameId = {
			...android,
			device: { ...android.device, id: ios.device.id },
		};
		expect(saveMobileRunProfile([ios], sameId)).toEqual([ios, sameId]);
	});
	it("keeps legacy profiles readable and ignores malformed persisted entries", () => {
		expect(
			readMobileRunProfiles([ios, null, {}, { ...android, device: null }]),
		).toEqual([ios]);
	});
	it("keeps the latest sixteen saved device profiles", () => {
		const profiles = Array.from({ length: 16 }, (_, i) => ({
			...ios,
			device: { ...ios.device, id: `phone-${i}` },
		}));
		expect(saveMobileRunProfile(profiles, android)).toEqual([
			...profiles.slice(1),
			android,
		]);
		const updated = { ...profiles[0], buildCommand: "updated" };
		expect(saveMobileRunProfile(profiles, updated)).toEqual([
			...profiles.slice(1),
			updated,
		]);
	});
});
