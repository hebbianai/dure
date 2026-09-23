import type {
	MobileDeviceAction,
	MobileDeviceTarget,
} from "@/lib/ipc/mobileSimulator";
import { definePaneAction } from "@/lib/workspace/pane/paneAction";
import {
	type MobilePaneControls,
	type MobilePresentation,
	mobileControlActions,
	mobileTargetParameters,
} from "./controlActions";
import { mobileInputActions } from "./inputActions";
import type { MobileRunProfile } from "./profile";

/** Each external mutation names the observed device, never whatever is now selected. */
export function mobilePaneActions(input: {
	presentation?: MobilePresentation;
	target: MobileDeviceTarget | null;
	status: () => unknown;
	isBusy: () => boolean;
	capture: () => Promise<unknown>;
	act: (action: MobileDeviceAction) => Promise<boolean>;
	run: (profile: MobileRunProfile) => Promise<void>;
	profiles: MobileRunProfile[];
	report: (appId: string) => Promise<unknown>;
	controls: MobilePaneControls;
}) {
	const expected = mobileTargetParameters;
	const matches = (args: { readonly [key: string]: unknown }) =>
		input.target?.id === args.deviceId &&
		input.target?.platform === args.platform;
	const changed = () =>
		({
			outcome: "refused",
			error: {
				code: "mobile_device_changed",
				message:
					"Inspect the pane and name its exact selected platform/device before acting.",
				retryable: false,
			},
		}) as const;
	return {
		...mobileControlActions(input),
		...mobileInputActions(input),
		"mobile.status": definePaneAction(
			{
				description:
					"Inspect selected device, saved profiles and current operation",
				parameters: {},
			},
			async () => ({ outcome: "unchanged", value: input.status() }),
		),
		"mobile.capture": definePaneAction(
			{
				description: "Save a fresh screenshot and return its local path",
				parameters: expected,
			},
			async (args) =>
				matches(args)
					? { outcome: "applied", value: await input.capture() }
					: changed(),
		),
		"mobile.act": definePaneAction(
			{
				description:
					"Operate the exact selected mobile device. action is a JSON object with kind and arguments.",
				parameters: {
					...expected,
					action: {
						type: "string",
						required: true,
						description:
							"JSON with kind: boot/open_native (iOS), install + path, launch + appId, open_url + url, type + ASCII text, key + enter/tab/escape (Android), paste + Unicode text (iOS, 1–8192 UTF-8 bytes), rotate + landscape boolean, button + home/back/recents, gesture + start/end {x,y} normalized 0..1 and width/height from mobile.capture. iOS touch/text/home/rotation requires an enabled live connection. Long operations may outlast the request; inspect mobile.status and never automatically replay.",
					},
				},
			},
			async (args) => {
				if (!matches(args)) return changed();
				let action: MobileDeviceAction;
				try {
					action = JSON.parse(String(args.action)) as MobileDeviceAction;
				} catch {
					return {
						outcome: "refused",
						error: {
							code: "mobile_action_invalid",
							message:
								"action must be a JSON object with kind and its arguments.",
							retryable: false,
						},
					};
				}
				return (await input.act(action))
					? { outcome: "applied" }
					: {
							outcome: "failed",
							error: {
								code: "mobile_operation_failed",
								message:
									"Inspect mobile.status for the operation failure; do not automatically replay a mutation.",
								retryable: false,
							},
						};
			},
		),
		"mobile.run": definePaneAction(
			{
				description:
					"Run a saved project profile; returns pending. Poll mobile.status for completion; do not resubmit.",
				parameters: {
					...expected,
					projectPath: { type: "string", required: true },
				},
			},
			async (args) => {
				if (!matches(args)) return changed();
				const profile = input.profiles.find(
					(profile) =>
						profile.projectPath === args.projectPath &&
						profile.device.id === args.deviceId &&
						profile.device.platform === args.platform,
				);
				if (!profile)
					return {
						outcome: "refused",
						error: {
							code: "mobile_profile_missing",
							message:
								"Save a profile for this exact device with mobile.profile.save first.",
							retryable: false,
						},
					};
				if (input.isBusy())
					return {
						outcome: "refused",
						error: {
							code: "mobile_device_busy",
							message: "Wait for the current operation to complete.",
							retryable: false,
						},
					};
				void input.run(profile);
				return { outcome: "pending" };
			},
		),
		"mobile.report": definePaneAction(
			{
				description:
					"Collect bounded app logs, device metadata and recent actions for review",
				parameters: { ...expected, appId: { type: "string", required: true } },
			},
			async (args) =>
				matches(args)
					? {
							outcome: "unchanged",
							value: await input.report(String(args.appId)),
						}
					: changed(),
		),
	};
}
