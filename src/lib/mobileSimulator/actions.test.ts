import { describe, expect, it, vi } from "vitest";
import { mobilePaneActions } from "./actions";
import { mobileInputActions } from "./inputActions";
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

it("pastes exact Unicode only for the selected idle iOS device", async () => {
	const target = { platform: "ios", id: "phone" } as const;
	const input = {
		target,
		isBusy: vi.fn(() => false),
		act: vi.fn(async () => true),
	};
	const actions = mobileInputActions(input);
	const args = {
		platform: "ios",
		deviceId: target.id,
		text: "한글 🙂\nline\t2",
	};
	expect(
		(await actions["mobile.paste"]({ ...args, deviceId: "other" })).outcome,
	).toBe("refused");
	input.isBusy.mockReturnValueOnce(true);
	expect((await actions["mobile.paste"](args)).outcome).toBe("refused");
	expect(input.act).not.toHaveBeenCalled();
	expect((await actions["mobile.paste"](args)).outcome).toBe("applied");
	expect(input.act).toHaveBeenCalledExactlyOnceWith({
		kind: "paste",
		text: args.text,
	});
	const android = mobileInputActions({ ...input, target: device });
	expect(
		(
			await android["mobile.paste"]({
				...args,
				platform: device.platform,
				deviceId: device.id,
			})
		).outcome,
	).toBe("refused");
	expect(input.act).toHaveBeenCalledTimes(1);
});
function fixture() {
	const input = {
		controls: {
			devices: vi.fn(async () => ({
				devices: [
					{ ...device, name: "QA", runtime: "Android", state: "ready" },
				],
				unavailable: [],
			})),
			select: vi.fn(),
			preview: vi.fn(),
			save: vi.fn(),
			remove: vi.fn(),
			report: vi.fn(() => null),
			agents: vi.fn(() => []),
		},
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

it("refuses hidden iOS preview and gestures with exact Space recovery instructions", async () => {
	const { input } = fixture();
	const target = { platform: "ios", id: "qa-ios" } as const;
	const actions = mobilePaneActions({
		...input,
		target,
		presentation: { active: false, spaceId: "qa-space", paneId: "qa-mobile" },
	});
	for (const [name, extra] of [
		["mobile.preview", { mode: "live" }],
		["mobile.tap", { x: 0.5, y: 0.5, width: 400, height: 800 }],
	] as const) {
		const result = await actions[name]({
			platform: target.platform,
			deviceId: target.id,
			...extra,
		});
		expect(result).toMatchObject({
			outcome: "refused",
			error: {
				code: "mobile_pane_hidden",
				nextAction: expect.stringContaining('"spaceId":"qa-space"'),
			},
		});
	}
	expect(input.act).not.toHaveBeenCalled();
	expect(input.controls.preview).not.toHaveBeenCalled();
});

it("named keys require the exact idle Android device and declared key choices", async () => {
	const { input, actions } = fixture();
	const args = { platform: device.platform, deviceId: device.id, key: "enter" };
	expect(
		(await actions["mobile.key"]({ ...args, deviceId: "other" })).outcome,
	).toBe("refused");
	expect(
		(await actions["mobile.key"]({ ...args, key: "66; reboot" })).outcome,
	).toBe("refused");
	input.isBusy.mockReturnValue(true);
	expect((await actions["mobile.key"](args)).outcome).toBe("refused");
	input.isBusy.mockReturnValue(false);
	expect((await actions["mobile.key"](args)).outcome).toBe("applied");
	expect(input.act).toHaveBeenCalledExactlyOnceWith({
		kind: "key",
		key: "enter",
	});
	const ios = mobileInputActions({
		...input,
		target: { platform: "ios", id: "ios" },
	});
	expect(
		(await ios["mobile.key"]({ ...args, platform: "ios", deviceId: "ios" }))
			.outcome,
	).toBe("refused");
	expect(input.act).toHaveBeenCalledTimes(1);
});
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

it("accepts simple typed input arguments and requires the dimensions of the observed frame", async () => {
	const { actions, input } = fixture();
	expect(
		(
			await actions["mobile.tap"]({
				...args,
				x: 0.25,
				y: 0.5,
				width: 400,
				height: 800,
			})
		).outcome,
	).toBe("applied");
	expect(input.act).toHaveBeenCalledExactlyOnceWith({
		kind: "gesture",
		start: { x: 0.25, y: 0.5 },
		end: { x: 0.25, y: 0.5 },
		width: 400,
		height: 800,
	});
	expect(
		(await actions["mobile.type"]({ ...args, text: "Dure" })).outcome,
	).toBe("applied");
	expect(input.act).toHaveBeenLastCalledWith({ kind: "type", text: "Dure" });
	expect(
		(
			await actions["mobile.swipe"]({
				...args,
				startX: 0.5,
				startY: 0.8,
				endX: 0.5,
				endY: 0.2,
			})
		).outcome,
	).toBe("refused");
	expect(input.act).toHaveBeenCalledTimes(2);
});

it("acknowledges slow boot and install without waiting and refuses overlapping work", async () => {
	const { actions, input } = fixture();
	for (const [name, parameters] of [
		["mobile.boot", {}],
		["mobile.install", { path: "/tmp/app.apk" }],
	] as const) {
		let finish!: (value: boolean) => void;
		input.act.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					finish = resolve;
				}),
		);
		const receipt = vi.fn();
		const request = actions[name]({ ...args, ...parameters }).then(receipt);
		await vi.waitFor(
			() => expect(receipt).toHaveBeenCalledWith({ outcome: "pending" }),
			{ timeout: 100 },
		);
		finish(true);
		await request;
	}
	input.isBusy.mockReturnValue(true);
	expect((await actions["mobile.boot"](args)).outcome).toBe("refused");
	expect(input.act).toHaveBeenCalledTimes(2);
});
