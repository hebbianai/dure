export interface MobileDeviceTarget {
	readonly platform: "ios" | "android";
	readonly id: string;
	readonly transport?: "iphone_mirroring";
}

export type MobileCapability =
	| "capture"
	| "live"
	| "boot"
	| "open_native"
	| "open_url"
	| "install"
	| "launch"
	| "gesture"
	| "foreground_tap"
	| "type"
	| "paste"
	| "key"
	| "rotate"
	| "home"
	| "back"
	| "recents"
	| "run";

export interface MobileDevice extends MobileDeviceTarget {
	readonly name: string;
	readonly runtime: string;
	readonly state: string;
	readonly kind?: "simulator" | "emulator" | "physical";
	readonly capabilities?: readonly MobileCapability[];
	readonly detail?: string | null;
}

export interface MobileDeviceCatalog {
	readonly devices: MobileDevice[];
	readonly unavailable: {
		platform: MobileDeviceTarget["platform"];
		transport?: MobileDeviceTarget["transport"];
		detail: string;
	}[];
}

export interface MobileFrame {
	readonly dataUrl: string;
	readonly width: number;
	readonly height: number;
}

export type MobileDeviceAction =
	| { kind: "boot" | "open_native" }
	| { kind: "open_url"; url: string }
	| { kind: "install"; path: string }
	| { kind: "launch"; appId: string }
	| { kind: "type" | "paste"; text: string }
	| { kind: "rotate"; landscape: boolean }
	| { kind: "button"; button: "home" | "back" | "recents" }
	| { kind: "key"; key: "enter" | "tab" | "escape" }
	| {
			kind: "gesture";
			start: { x: number; y: number };
			end: { x: number; y: number };
			width: number;
			height: number;
			foreground?: boolean;
	  };

export interface MobileDiagnosticReport {
	device: MobileDevice;
	appId: string;
	logs: string;
	logError: string | null;
	recentActions: { atMs: number; kind: string; succeeded: boolean }[];
}
