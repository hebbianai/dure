export interface BrowserProfileRecord {
	readonly profile: {
		readonly profileId: string;
		readonly label: string;
		readonly scope: "default" | "isolated" | "imported";
		readonly userAgentMode: "clean" | "native";
	};
	readonly state: "active" | "retiring" | "deleted";
}


export function isBrowserProfileLabel(value: unknown): value is string;
export function parseBrowserProfile(value: unknown): BrowserProfileRecord | undefined;
export function parseBrowserProfiles(value: unknown): BrowserProfileRecord[] | undefined;
