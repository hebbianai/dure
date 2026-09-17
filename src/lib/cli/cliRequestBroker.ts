import { cliRequestClaim, cliRequestComplete } from "@/lib/ipc";
import { projectCliSpaceReceipt } from "@/lib/cli/cliSpaceIdentity";

export function claimCliRequest(reqId: string): Promise<boolean> {
	return cliRequestClaim(reqId);
}

export async function completeCliRequest(
	reqId: string,
	result: unknown,
	action: string,
): Promise<void> {
	await cliRequestComplete(reqId, projectCliSpaceReceipt(result)).catch((error) => {
		console.error(`[cli ${action}] receipt failed: ${error}`);
	});
}
