import type {
	MobileDeviceCatalog,
	MobileDeviceTarget,
} from "@/lib/ipc/mobileSimulator";
import {
	definePaneAction,
	type PaneActionExecution,
} from "@/lib/workspace/pane/paneAction";
import { type MobileRunProfile, readMobileRunProfiles } from "./profile";

export type MobilePreviewMode = "snapshot" | "auto" | "live";
export interface MobileReportControls {
	busy(): boolean;
	prepare(appId: string): Promise<{
		reportId: string;
		text: string;
		screenshot: { path: string; width: number; height: number };
	}>;
	draft(reportId: string, agentId: string, text?: string): Promise<void>;
}
export interface MobilePaneControls {
	devices(): Promise<MobileDeviceCatalog>;
	select(target: MobileDeviceTarget | null): void;
	preview(mode: MobilePreviewMode): void;
	save(profile: MobileRunProfile): void;
	remove(projectPath: string): void;
	report(): MobileReportControls | null;
	agents(): { id: string; name: string }[];
}
export const mobileTargetParameters = {
	deviceId: { type: "string", required: true },
	platform: { type: "string", required: true, values: ["ios", "android"] },
} as const;
export function mobileRefusal(
	code: string,
	message: string,
): PaneActionExecution {
	return { outcome: "refused", error: { code, message, retryable: false } };
}

/** Controls call the pane's UI owners; discovery never starts or selects a device. */
export function mobileControlActions(input: {
	target: MobileDeviceTarget | null;
	isBusy(): boolean;
	controls: MobilePaneControls;
}) {
	const controls = input.controls;
	const guarded = async (
		args: { readonly [key: string]: unknown },
		run: () => Promise<PaneActionExecution>,
	): Promise<PaneActionExecution> => {
		if (input.isBusy())
			return mobileRefusal(
				"mobile_device_busy",
				"Wait for the current operation to complete.",
			);
		if (
			input.target?.id !== args.deviceId ||
			input.target?.platform !== args.platform
		)
			return mobileRefusal(
				"mobile_device_changed",
				"Select this exact device with mobile.select before acting.",
			);
		return run();
	};
	return {
		"mobile.devices": definePaneAction(
			{
				description:
					"Refresh and list devices, their exact identities, readiness and missing SDKs. Does not boot or select.",
				parameters: {},
			},
			async () => ({ outcome: "unchanged", value: await controls.devices() }),
		),
		"mobile.select": definePaneAction(
			{
				description:
					"Select one device returned by mobile.devices. Stops the prior preview; does not boot or run a profile.",
				parameters: mobileTargetParameters,
			},
			async (args) => {
				if (input.isBusy())
					return mobileRefusal(
						"mobile_device_busy",
						"Wait for the current operation to complete.",
					);
				const catalog = await controls.devices();
				const device = catalog.devices.find(
					(device) =>
						device.id === args.deviceId && device.platform === args.platform,
				);
				if (!device)
					return mobileRefusal(
						"mobile_device_missing",
						"Device unavailable. Inspect mobile.devices.",
					);
				if (input.isBusy())
					return mobileRefusal(
						"mobile_device_busy",
						"Wait for the current operation to complete.",
					);
				controls.select({ platform: device.platform, id: device.id });
				return { outcome: "applied", value: device };
			},
		),
		"mobile.clear": definePaneAction(
			{
				description:
					"Clear this exact selection and stop its preview without shutting down the device.",
				parameters: mobileTargetParameters,
			},
			(args) =>
				guarded(args, async () => {
					controls.select(null);
					return { outcome: "applied" };
				}),
		),
		"mobile.preview": definePaneAction(
			{
				description:
					"Set snapshot, 1-second auto refresh, or live iOS mode. Poll mobile.status for preview readiness/errors. Live requires a running iOS device and a visible pane.",
				parameters: {
					...mobileTargetParameters,
					mode: {
						type: "string",
						required: true,
						values: ["snapshot", "auto", "live"],
					},
				},
			},
			(args) =>
				guarded(args, async () => {
					if (args.mode === "live" && args.platform !== "ios")
						return mobileRefusal(
							"mobile_preview_unsupported",
							"Live mode is available for iOS; use auto for Android.",
						);
					controls.preview(args.mode as MobilePreviewMode);
					return { outcome: "pending" };
				}),
		),
		"mobile.profile.save": definePaneAction(
			{
				description:
					"Save or replace a project profile for this exact device. Never executes it; call mobile.run explicitly.",
				parameters: {
					...mobileTargetParameters,
					projectPath: { type: "string", required: true },
					appId: { type: "string", required: true },
					buildCommand: { type: "string" },
					artifactPath: { type: "string" },
					url: { type: "string" },
				},
			},
			(args) =>
				guarded(args, async () => {
					const [profile] = readMobileRunProfiles([
						{
							projectPath: String(args.projectPath).trim(),
							appId: String(args.appId).trim(),
							buildCommand: args.buildCommand ?? "",
							artifactPath: args.artifactPath ?? "",
							url: args.url ?? "",
							device: input.target,
						},
					]);
					if (!profile)
						return mobileRefusal(
							"mobile_profile_invalid",
							"A project folder and app ID are required.",
						);
					controls.save(profile);
					return { outcome: "applied", value: profile };
				}),
		),
		"mobile.profile.remove": definePaneAction(
			{
				description:
					"Remove a saved project profile from this pane; never deletes project files or apps.",
				parameters: { projectPath: { type: "string", required: true } },
			},
			async (args) => {
				if (input.isBusy())
					return mobileRefusal(
						"mobile_device_busy",
						"Wait for the current operation to complete.",
					);
				controls.remove(String(args.projectPath));
				return { outcome: "applied" };
			},
		),
		"mobile.report.agents": definePaneAction(
			{
				description:
					"List currently available agent draft recipients. Does not send input.",
				parameters: {},
			},
			async () => ({ outcome: "unchanged", value: controls.agents() }),
		),
		"mobile.report.prepare": definePaneAction(
			{
				description:
					"Prepare an editable diagnostic packet in the UI and return its report ID, text and screenshot path. Review before calling mobile.report.draft.",
				parameters: {
					...mobileTargetParameters,
					appId: { type: "string", required: true },
				},
			},
			(args) =>
				guarded(args, async () => {
					const report = controls.report();
					if (!report)
						return mobileRefusal(
							"mobile_report_unavailable",
							"Select a running device before preparing a report.",
						);
					return {
						outcome: "applied",
						value: await report.prepare(String(args.appId)),
					};
				}),
		),
		"mobile.report.draft": definePaneAction(
			{
				description:
					"Put the reviewed prepared packet into one explicit agent's draft without submitting. reportId must match mobile.report.prepare; optional text replaces the report with edited/redacted notes. Requires authorization to write to that recipient.",
				parameters: {
					...mobileTargetParameters,
					reportId: { type: "string", required: true },
					agentId: { type: "string", required: true },
					text: { type: "string" },
				},
			},
			(args) =>
				guarded(args, async () => {
					const report = controls.report();
					if (!report)
						return mobileRefusal(
							"mobile_report_unavailable",
							"Prepare a report for this running device first.",
						);
					await report.draft(
						String(args.reportId),
						String(args.agentId),
						args.text === undefined ? undefined : String(args.text),
					);
					return {
						outcome: "applied",
						value: { submitted: false, agentId: args.agentId },
					};
				}),
		),
	};
}
