import type { AccountProfile, Provider } from "@/types";

const RECOVERABLE_PROFILE_CODES = new Set([
	"credential_directory_untrusted",
	"credential_file_untrusted",
	"credential_overlay_wrong_target",
	"credential_overlay_wrong_type",
]);

export interface CredentialProfileRecovery {
	kind: "create_replacement_profile";
	accountId: string;
	provider: Provider;
	accountName: string;
	profileDirectory: string;
	suggestedName: string;
	errorCode: string;
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error && typeof error === "object" && "message" in error) {
		return String(error.message);
	}
	return String(error);
}

export function credentialSwitchErrorCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error) {
		const code = String(error.code);
		if (/^credential_[a-z0-9_]+$/.test(code)) return code;
	}
	return errorText(error).match(/\b(credential_[a-z0-9_]+)(?::|$)/)?.[1];
}

export function credentialProfileRecovery(
	error: unknown,
	account: AccountProfile | undefined,
): CredentialProfileRecovery | undefined {
	if (!account) return undefined;
	const errorCode = credentialSwitchErrorCode(error);
	if (!errorCode || !RECOVERABLE_PROFILE_CODES.has(errorCode)) return undefined;
	const name = account.name.trim() || account.provider;
	return {
		kind: "create_replacement_profile",
		accountId: account.id,
		provider: account.provider,
		accountName: account.name,
		profileDirectory: account.dir,
		suggestedName: `${name}-new`,
		errorCode,
	};
}

export async function runCredentialSwitchWithFeedback(options: {
	execute: () => Promise<unknown>;
	account?: AccountProfile;
	onRecovery: (recovery: CredentialProfileRecovery) => void;
	onFailure: (error: unknown) => unknown | Promise<unknown>;
}): Promise<"completed" | "failed" | "recovery"> {
	try {
		await options.execute();
		return "completed";
	} catch (error) {
		const recovery = credentialProfileRecovery(error, options.account);
		if (recovery) {
			options.onRecovery(recovery);
			return "recovery";
		}
		await options.onFailure(error);
		return "failed";
	}
}
