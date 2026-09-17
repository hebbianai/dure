export interface MobileDeviceTarget {
	readonly platform: "ios" | "android";
	readonly id: string;
}

interface MobileDevice extends MobileDeviceTarget {
	readonly name: string;
	readonly runtime: string;
	readonly state: string;
}

export interface MobileDeviceCatalog {
	readonly devices: MobileDevice[];
	readonly unavailable: {
		platform: MobileDeviceTarget["platform"];
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
	| { kind: "type"; text: string }
	| { kind: "rotate"; landscape: boolean }
	| { kind: "button"; button: "home" | "back" | "recents" }
	| {
			kind: "gesture";
			start: { x: number; y: number };
			end: { x: number; y: number };
			width: number;
			height: number;
	  };

export interface MobileDiagnosticReport {
	device: MobileDevice;
	appId: string;
	logs: string;
	logError: string | null;
	recentActions: { atMs: number; kind: string; succeeded: boolean }[];
}
