import type { HmuxAgentProgress } from "@/lib/ipc/hmuxContracts";

const record = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown): v is string =>
	typeof v === "string" && /^[A-Za-z0-9._:+-]{1,256}$/.test(v);
const decimal = (v: unknown): v is string =>
	typeof v === "string" &&
	/^(0|[1-9][0-9]{0,19})$/.test(v) &&
	BigInt(v) <= 18446744073709551615n;

/** Optional observations from newer Hosts must not invalidate older lifecycle data. */
export function parseAgentProgress(
	value: unknown,
): HmuxAgentProgress | undefined {
	if (!record(value) || !record(value.report)) return undefined;
	const r = value.report;
	if (
		!id(r.source_id) ||
		!decimal(r.sequence) ||
		r.sequence === "0" ||
		!["thinking", "tool_running", "waiting"].includes(String(r.phase)) ||
		!(r.turn_id === null || id(r.turn_id)) ||
		!Array.isArray(r.message_turns) ||
		r.message_turns.length > 32 ||
		!r.message_turns.every(
			(m) => record(m) && id(m.delivery_receipt_id) && id(m.turn_id),
		) ||
		!decimal(value.last_activity_unix_ms) ||
		!decimal(value.quiet_threshold_ms) ||
		value.quiet_threshold_ms === "0" ||
		typeof value.progress_unconfirmed !== "boolean"
	)
		return undefined;
	return value as unknown as HmuxAgentProgress;
}
