import { describe, expect, it, vi } from "vitest";
import {
	type MobilePaneControls,
	mobileControlActions,
} from "./controlActions";

const target = { platform: "ios", id: "owned-device" } as const;
const args = { platform: target.platform, deviceId: target.id };
function fixture() {
	const report = {
		busy: () => false,
		prepare: vi.fn(async () => ({
			reportId: "packet",
			text: "logs",
			screenshot: { path: "/tmp/report.png", width: 400, height: 800 },
		})),
		draft: vi.fn(async () => {}),
	};
	const controls = {
		devices: vi.fn(async () => ({
			devices: [{ ...target, name: "Phone", runtime: "iOS", state: "ready" }],
			unavailable: [],
		})),
		select: vi.fn(),
		preview: vi.fn(),
		save: vi.fn(),
		remove: vi.fn(),
		report: vi.fn(() => report),
		agents: vi.fn(() => [{ id: "agent", name: "Agent" }]),
	} satisfies MobilePaneControls;
	const input = { target, controls, isBusy: vi.fn(() => false) };
	return { input, report, controls, actions: mobileControlActions(input) };
}
describe("agent-accessible mobile workflows", () => {
	it("discovers before selecting the exact device and refuses unavailable identities", async () => {
		const { actions, controls } = fixture();
		expect((await actions["mobile.devices"]()).outcome).toBe("unchanged");
		expect(controls.select).not.toHaveBeenCalled();
		expect(
			(await actions["mobile.select"]({ ...args, deviceId: "missing" }))
				.outcome,
		).toBe("refused");
		expect(controls.select).not.toHaveBeenCalled();
		expect((await actions["mobile.select"](args)).outcome).toBe("applied");
		expect(controls.select).toHaveBeenCalledExactlyOnceWith(target);
	});
	it("rechecks the operation owner after slow discovery", async () => {
		const { actions, controls, input } = fixture();
		controls.devices.mockImplementationOnce(async () => {
			input.isBusy.mockReturnValue(true);
			return {
				devices: [{ ...target, name: "Phone", runtime: "iOS", state: "ready" }],
				unavailable: [],
			};
		});
		expect((await actions["mobile.select"](args)).outcome).toBe("refused");
		expect(controls.select).not.toHaveBeenCalled();
	});
	it("saves without running and blocks stale-device profile/preview/report changes", async () => {
		const { actions, controls, report } = fixture();
		expect(
			(
				await actions["mobile.profile.save"]({
					...args,
					projectPath: "/project",
					appId: "com.dure.qa",
					buildCommand: "printf build",
				})
			).outcome,
		).toBe("applied");
		expect(controls.save).toHaveBeenCalledExactlyOnceWith({
			projectPath: "/project",
			appId: "com.dure.qa",
			buildCommand: "printf build",
			artifactPath: "",
			url: "",
			device: target,
		});
		expect(
			(
				await actions["mobile.profile.save"]({
					...args,
					projectPath: " ",
					appId: "app",
				})
			).outcome,
		).toBe("refused");
		expect(
			(
				await actions["mobile.preview"]({
					...args,
					deviceId: "stale",
					mode: "live",
				})
			).outcome,
		).toBe("refused");
		expect(
			(
				await actions["mobile.report.prepare"]({
					...args,
					deviceId: "stale",
					appId: "app",
				})
			).outcome,
		).toBe("refused");
		expect(controls.preview).not.toHaveBeenCalled();
		expect(report.prepare).not.toHaveBeenCalled();
	});
	it("prepares for review and requires a separate explicit recipient delivery", async () => {
		const { actions, report } = fixture();
		const prepared = await actions["mobile.report.prepare"]({
			...args,
			appId: "com.dure.qa",
		});
		expect(prepared).toMatchObject({
			outcome: "applied",
			value: {
				reportId: "packet",
				text: "logs",
				screenshot: { path: "/tmp/report.png" },
			},
		});
		expect(report.draft).not.toHaveBeenCalled();
		expect(
			(await actions["mobile.report.draft"]({ ...args, reportId: "packet" }))
				.outcome,
		).toBe("refused");
		expect(
			await actions["mobile.report.draft"]({
				...args,
				reportId: "packet",
				agentId: "agent",
				text: "redacted",
			}),
		).toEqual({
			outcome: "applied",
			value: { submitted: false, agentId: "agent" },
		});
		expect(report.draft).toHaveBeenCalledExactlyOnceWith(
			"packet",
			"agent",
			"redacted",
		);
	});
});
