import { expect, it } from "vitest";
import { isIosSimulator, mobileCapabilities } from "./capabilities";
import { readMobileDeviceTarget } from "./preview";
import type { MobileDevice } from "./types";

const physical: MobileDevice = {
	platform: "ios",
	id: "mirroring:42:EKWlAAAAAAA:99",
	transport: "iphone_mirroring",
	kind: "physical",
	name: "iPhone",
	runtime: "iPhone Mirroring",
	state: "ready",
	capabilities: ["capture", "home", "recents"],
};
it("preserves the physical transport through saved selection and never invents simulator capabilities", () => {
	expect(readMobileDeviceTarget(physical)).toEqual({
		platform: "ios",
		id: physical.id,
		transport: "iphone_mirroring",
	});
	expect(isIosSimulator(physical)).toBe(false);
	expect(mobileCapabilities(physical)).not.toContain("live");
	expect(mobileCapabilities({ ...physical, capabilities: undefined })).toEqual(
		[],
	);
	expect(
		readMobileDeviceTarget({ ...physical, transport: "unknown" }),
	).toBeNull();
	expect(
		readMobileDeviceTarget({ ...physical, platform: "android" }),
	).toBeNull();
});
it("preserves the capabilities of legacy simulator and Android catalogs", () => {
	expect(
		mobileCapabilities({
			...physical,
			transport: undefined,
			capabilities: undefined,
		}),
	).toContain("live");
	expect(
		mobileCapabilities({
			...physical,
			platform: "android",
			transport: undefined,
			capabilities: undefined,
		}),
	).toContain("key");
});
