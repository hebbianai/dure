import { cliInputErrorPayload } from "@/lib/cli/cliInputError";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import {
	executeExactHmuxInput,
	executeManagedAgentInput,
	prepareExactHmuxInput,
	prepareManagedAgentInput,
} from "@/lib/sessions/managed/managedAgentInput";

async function handleClaimedHmuxInput<Prepared, Result>(
	reqId: string,
	prepare: () => Prepared,
	execute: (prepared: Prepared) => Promise<Result>,
) {
	let claimed = false;
	const claim = async () => {
		if (claimed) return true;
		claimed = await claimCliRequest(reqId);
		return claimed;
	};
	try {
		const prepared = prepare();
		if (!(await claim())) return null;
		return { ok: true, input: await execute(prepared) };
	} catch (error) {
		if (!(await claim())) return null;
		return { ok: false, error: cliInputErrorPayload(error) };
	}
}

export function handleManagedHmuxInput(
	params: Record<string, unknown>,
	reqId: string,
) {
	return handleClaimedHmuxInput(
		reqId,
		() => prepareManagedAgentInput(params),
		executeManagedAgentInput,
	);
}

export function handleExactHmuxInput(
	params: Record<string, unknown>,
	reqId: string,
) {
	return handleClaimedHmuxInput(
		reqId,
		() => prepareExactHmuxInput(params),
		executeExactHmuxInput,
	);
}
