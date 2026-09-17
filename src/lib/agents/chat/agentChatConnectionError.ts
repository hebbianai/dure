import { DureBackendRequestError } from "@/lib/ipc/dureBackend";

export function agentChatErrorMessage(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: String(error);
}

export function shouldReconnectAgentChat(error: unknown): boolean {
	if (!(error instanceof DureBackendRequestError)) return true;
	return (
		error.failure.kind === "transport" ||
		error.failure.kind === "authority_changed" ||
		(error.failure.kind === "operation" &&
			error.failure.disposition !== "terminal")
	);
}
