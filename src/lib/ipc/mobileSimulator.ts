import { invoke } from "@tauri-apps/api/core";
import type { MobileRunProfile } from "@/lib/mobileSimulator/profile";
import type {
	MobileDeviceAction,
	MobileDeviceCatalog,
	MobileDeviceTarget,
	MobileDiagnosticReport,
	MobileFrame,
} from "@/lib/mobileSimulator/types";
import { currentWebviewInstanceIdentity } from "@/lib/platform/webviewInstanceIdentity";

export type {
	MobileDeviceAction,
	MobileDeviceCatalog,
	MobileDeviceTarget,
	MobileDiagnosticReport,
	MobileFrame,
} from "@/lib/mobileSimulator/types";

export const mobileSimulator = {
	liveStart: (target: MobileDeviceTarget) =>
		invoke<string>("mobile_simulator_live_start", {
			target,
			webviewInstanceId: currentWebviewInstanceIdentity().instanceId,
		}),
	liveFrame: (id: string) =>
		invoke<MobileFrame | null>("mobile_simulator_live_frame", { id }),
	liveStop: (id: string) => invoke<void>("mobile_simulator_live_stop", { id }),
	run: (target: MobileDeviceTarget, profile: MobileRunProfile) =>
		invoke<{ buildOutput: string }>("mobile_simulator_run", {
			target,
			profile,
		}),
	report: (target: MobileDeviceTarget, appId: string) =>
		invoke<MobileDiagnosticReport>("mobile_simulator_report", {
			target,
			appId,
		}),
	list: () => invoke<MobileDeviceCatalog>("mobile_simulator_list"),
	capture: (target: MobileDeviceTarget) =>
		invoke<MobileFrame>("mobile_simulator_capture", { target }),
	act: (target: MobileDeviceTarget, action: MobileDeviceAction) =>
		invoke<void>("mobile_simulator_act", { target, action }),
};
