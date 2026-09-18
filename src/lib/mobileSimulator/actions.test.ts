import { describe, expect, it, vi } from "vitest";
import { mobilePaneActions } from "./actions";
import {
	type MobileRunProfile,
	readMobileRunProfiles,
	saveMobileRunProfile,
} from "./profile";

const device = { platform: "android", id: "emulator-5554" } as const;
const profile = {
	projectPath: "/project",
	buildCommand: "pnpm build",
	artifactPath: "app.apk",
	appId: "com.dure.qa",
	url: "",
	device,
};
const args = { platform: device.platform, deviceId: device.id };
function fixture() {
	const input = {
		target: device,
		profiles: [profile] as MobileRunProfile[],
		isBusy: vi.fn(() => false),
		status: vi.fn(() => ({ device, busy: false })),
		act: vi.fn(async () => true),
		capture: vi.fn(async () => ({ path: "/tmp/screen.png" })),
		report: vi.fn(async () => ({})),
		run: vi.fn(async () => {}),
	};
	return { input, actions: mobilePaneActions(input) };
}
describe("mobile pane actions", () => {
	it("refuses stale device identity without sending any input", async () => {
		const { input, actions } = fixture();
		expect(
			(
				await actions["mobile.act"]({
					...args,
					deviceId: "other",
					action: '{"kind":"button","button":"home"}',
				})
			).outcome,
		).toBe("refused");
		expect(input.act).not.toHaveBeenCalled();
	});
	it("uses the same operation callback and surfaces failures", async () => {
		const { input, actions } = fixture();
		input.act.mockResolvedValue(false);
		expect(
			(
				await actions["mobile.act"]({
					...args,
					action: '{"kind":"button","button":"home"}',
				})
			).outcome,
		).toBe("failed");
		expect(input.act).toHaveBeenCalledWith({ kind: "button", button: "home" });
	});
	it("admits a saved exact-device profile once and reports pending for polling", async () => {
		const { input, actions } = fixture();
		input.isBusy.mockReturnValueOnce(true);
		expect(
			(await actions["mobile.run"]({ ...args, projectPath: "/project" }))
				.outcome,
		).toBe("refused");
		expect(input.run).not.toHaveBeenCalled();
		expect(
			(await actions["mobile.run"]({ ...args, projectPath: "/project" }))
				.outcome,
		).toBe("pending");
		expect(input.run).toHaveBeenCalledExactlyOnceWith(profile);
	});
	it("can still run the selected device after saving another device for the same project", async () => {
		const { input, actions } = fixture();
		input.profiles = saveMobileRunProfile([profile], {
			...profile,
			buildCommand: "pnpm build:other",
			device: { ...device, id: "emulator-5556" },
		});
		expect(
			(await actions["mobile.run"]({ ...args, projectPath: "/project" }))
				.outcome,
		).toBe("pending");
		expect(input.run).toHaveBeenCalledExactlyOnceWith(profile);
	});
	it("never accepts an unsaved build command through run", async () => {
		const { input, actions } = fixture();
		expect(
			(await actions["mobile.run"]({ ...args, projectPath: "/elsewhere" }))
				.outcome,
		).toBe("refused");
		expect(
			(
				await actions["mobile.run"]({
					...args,
					projectPath: "/project",
					buildCommand: "other",
				})
			).outcome,
		).toBe("refused");
		expect(input.run).not.toHaveBeenCalled();
	});
	it("returns capture artifacts only for the selected device", async () => {
		const { input, actions } = fixture();
		expect(await actions["mobile.capture"](args)).toEqual({
			outcome: "applied",
			value: { path: "/tmp/screen.png" },
		});
		expect(input.capture).toHaveBeenCalledOnce();
	});
});
it("restores bounded complete profiles and replaces only the same project and device", () => {
	expect(
		readMobileRunProfiles([profile, {}, { ...profile, device: null }]),
	).toEqual([profile]);
	const other = { ...profile, projectPath: "/other" };
	expect(
		saveMobileRunProfile([profile, other], {
			...profile,
			appId: "com.dure.changed",
		}),
	).toEqual([other, { ...profile, appId: "com.dure.changed" }]);
});
