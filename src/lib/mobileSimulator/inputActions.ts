import type {
	MobileDeviceAction,
	MobileDeviceTarget,
} from "@/lib/ipc/mobileSimulator";
import {
	definePaneAction,
	type PaneActionArguments,
	type PaneActionDefinition,
} from "@/lib/workspace/pane/paneAction";
import {
	type MobilePresentation,
	mobileHiddenPresentation,
	mobileRefusal,
	mobileTargetParameters,
} from "./controlActions";

/** Named actions spare callers nested SDK JSON while sharing the UI operation owner. */
export function mobileInputActions(input: {
	presentation?: MobilePresentation;
	target: MobileDeviceTarget | null;
	isBusy(): boolean;
	act(action: MobileDeviceAction): Promise<boolean>;
}) {
	const command = (
		description: string,
		parameters: PaneActionDefinition["parameters"],
		action: (args: PaneActionArguments) => MobileDeviceAction,
	) =>
		definePaneAction(
			{ description, parameters: { ...mobileTargetParameters, ...parameters } },
			async (args) => {
				if (
					input.target?.id !== args.deviceId ||
					input.target?.platform !== args.platform
				)
					return mobileRefusal(
						"mobile_device_changed",
						"Select this exact device with mobile.select before acting.",
					);
				if (input.isBusy())
					return mobileRefusal(
						"mobile_device_busy",
						"Wait for the current operation to complete.",
					);
				const operation = action(args);
				if (operation.kind === "key" && input.target.platform !== "android")
					return mobileRefusal(
						"mobile_action_unsupported",
						"Named keys currently require Android. iOS key input is unsupported.",
					);
				if (
					input.target.platform === "ios" &&
					["gesture", "type", "paste", "button", "rotate"].includes(
						operation.kind,
					)
				) {
					const hidden = mobileHiddenPresentation(input.presentation);
					if (hidden) return hidden;
				}
				if (operation.kind === "paste" && input.target.platform !== "ios")
					return mobileRefusal(
						"mobile_action_unsupported",
						"Paste requires an iOS simulator with ready live mode.",
					);
				if (operation.kind === "boot" || operation.kind === "install") {
					void input.act(operation);
					return { outcome: "pending" };
				}
				return (await input.act(operation))
					? { outcome: "applied" }
					: {
							outcome: "failed",
							error: {
								code: "mobile_operation_failed",
								message:
									"Inspect mobile.status; do not automatically replay a mutation.",
								retryable: false,
							},
						};
			},
		);
	const text = { type: "string", required: true } as const;
	const coordinate = { type: "number", minimum: 0, required: true } as const;
	const dimensions = {
		width: { type: "integer", minimum: 1, required: true },
		height: { type: "integer", minimum: 1, required: true },
	} as const;
	const gesture = (
		args: PaneActionArguments,
		start: { x: number; y: number },
		end = start,
	): MobileDeviceAction => ({
		kind: "gesture",
		start,
		end,
		width: Number(args.width),
		height: Number(args.height),
	});
	return {
		"mobile.boot": command(
			"Boot the selected iOS simulator; returns pending. Poll mobile.status for busy=false and errors; never resubmit automatically. Android must already be running.",
			{},
			() => ({ kind: "boot" }),
		),
		"mobile.open-native": command(
			"Open this exact iOS device in Apple Simulator.",
			{},
			() => ({ kind: "open_native" }),
		),
		"mobile.install": command(
			"Install a local .app on iOS or .apk on Android; returns pending. Poll mobile.status for busy=false and errors; never resubmit automatically.",
			{ path: text },
			(args) => ({ kind: "install", path: String(args.path) }),
		),
		"mobile.launch": command(
			"Launch this exact bundle/package ID.",
			{ appId: text },
			(args) => ({ kind: "launch", appId: String(args.appId) }),
		),
		"mobile.open-url": command(
			"Open a URL or app deep link on the selected device.",
			{ url: text },
			(args) => ({ kind: "open_url", url: String(args.url) }),
		),
		"mobile.type": command(
			"Type printable ASCII into the focused guest field. iOS requires ready live mode; Android excludes %.",
			{ text },
			(args) => ({ kind: "type", text: String(args.text) }),
		),
		"mobile.key": command(
			"Press Enter, Tab or Escape on the exact selected Android device. Enter submits focused fields when supported by the app/IME. Uses normal device operation receipts and does not change protected screenshot behavior. iOS is unsupported.",
			{ key: { ...text, values: ["enter", "tab", "escape"] } },
			(args) => ({ kind: "key", key: args.key as "enter" | "tab" | "escape" }),
		),
		"mobile.paste": command(
			"Paste exact text into the focused iOS guest field through that simulator's clipboard. Requires ready live mode. Accepts 1–8192 UTF-8 bytes (agent arguments also have a 4096-character limit), including Unicode, tabs and line breaks. Leaves the guest clipboard updated; does not access the host clipboard. Android is unsupported.",
			{ text },
			(args) => ({ kind: "paste", text: String(args.text) }),
		),
		"mobile.button": command(
			"Press home on iOS live mode, or home/back/recents on Android.",
			{ button: { ...text, values: ["home", "back", "recents"] } },
			(args) => ({
				kind: "button",
				button: args.button as "home" | "back" | "recents",
			}),
		),
		"mobile.rotate": command(
			"Set portrait or landscape. Refresh the frame before subsequent touch input.",
			{ landscape: { type: "boolean", required: true } },
			(args) => ({ kind: "rotate", landscape: Boolean(args.landscape) }),
		),
		"mobile.tap": command(
			"Tap normalized x/y (0..1) with width/height from mobile.capture; stale orientation is refused. iOS requires ready live mode.",
			{ ...dimensions, x: coordinate, y: coordinate },
			(args) => gesture(args, { x: Number(args.x), y: Number(args.y) }),
		),
		"mobile.swipe": command(
			"Swipe between normalized 0..1 coordinates with width/height from mobile.capture; stale orientation is refused.",
			{
				...dimensions,
				startX: coordinate,
				startY: coordinate,
				endX: coordinate,
				endY: coordinate,
			},
			(args) =>
				gesture(
					args,
					{ x: Number(args.startX), y: Number(args.startY) },
					{ x: Number(args.endX), y: Number(args.endY) },
				),
		),
	};
}
