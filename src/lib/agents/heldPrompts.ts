import type {
	HmuxAgentRuntimeState,
	HmuxHeldPrompts,
} from "@/lib/ipc/hmuxContracts";

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Optional presentation from newer Hosts must never invalidate the Host's
 * semantic state: anything malformed is simply absent. */
export function parseHeldPrompts(value: unknown): HmuxHeldPrompts | undefined {
	if (
		!record(value) ||
		!Number.isSafeInteger(value.count) ||
		(value.count as number) < 1 ||
		!Number.isSafeInteger(value.sinceUnixMs) ||
		(value.sinceUnixMs as number) < 0
	)
		return undefined;
	return {
		count: value.count as number,
		sinceUnixMs: value.sinceUnixMs as number,
	};
}

/** The prompts a running agent's unsent input holds back, if any. */
export function heldPromptsOf(
	runtime: Pick<HmuxAgentRuntimeState, "lifecycle" | "heldPrompts"> | undefined,
): HmuxHeldPrompts | undefined {
	return runtime?.lifecycle === "running" ? runtime.heldPrompts : undefined;
}
