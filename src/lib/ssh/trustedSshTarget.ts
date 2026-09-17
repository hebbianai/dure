import type { SshHostConfig } from "@/types";

/** Immutable, host-key-pinned SSH authority shared by remote adapters. */
export interface TrustedSshTargetV1 {
	readonly schemaVersion: 1;
	readonly hostId: string;
	readonly host: string;
	readonly port: number;
	readonly user: string;
	readonly auth: SshHostConfig["auth"];
	readonly secretId?: string;
	readonly keyPath?: string;
	readonly hostKeyFingerprints: readonly string[];
}
