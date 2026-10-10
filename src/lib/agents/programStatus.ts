import type { HmuxProgramStatus } from "@/lib/ipc/hmuxContracts";

const STATES = new Set(["idle", "working", "blocked", "done", "error"]);
const BLOCKED_KINDS = new Set(["permission", "question", "auth"]);
const APP = /^[A-Za-z0-9_.+-]{1,32}$/;
const MESSAGE_MAX_BYTES = 2048;
const CONTROL = /\p{Cc}/u;
// The Host already removes bidirectional and invisible formatting characters;
// rendering removes them again so no Host version can reorder header text.
const FORMATTING = /\p{Cf}/gu;

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Optional presentation from newer Hosts must never invalidate the Host's
 * semantic state: anything malformed is simply absent. */
export function parseProgramStatus(
	value: unknown,
): HmuxProgramStatus | undefined {
	if (!record(value) || !STATES.has(String(value.state))) return undefined;
	const state = value.state as HmuxProgramStatus["state"];
	const { blocked_kind, app, message } = value;
	if (
		(blocked_kind !== undefined &&
			(state !== "blocked" || !BLOCKED_KINDS.has(String(blocked_kind)))) ||
		(app !== undefined && (typeof app !== "string" || !APP.test(app))) ||
		(message !== undefined &&
			(typeof message !== "string" ||
				message.length === 0 ||
				new TextEncoder().encode(message).length > MESSAGE_MAX_BYTES ||
				CONTROL.test(message)))
	)
		return undefined;
	return {
		state,
		...(blocked_kind === undefined
			? {}
			: { blocked_kind: blocked_kind as HmuxProgramStatus["blocked_kind"] }),
		...(app === undefined ? {} : { app: app as string }),
		...(message === undefined ? {} : { message: message as string }),
	};
}

export type ProgramStatusNoticeKind =
	| "permission"
	| "question"
	| "auth"
	| "blocked"
	| "error";

export interface ProgramStatusNotice {
	kind: ProgramStatusNoticeKind;
	app?: string;
	message?: string;
}

/** Normal execution stays quiet: a program's own report earns a notice only
 * when it says it needs the user or has failed. */
export function programStatusNotice(
	status: HmuxProgramStatus | undefined,
): ProgramStatusNotice | undefined {
	if (status?.state !== "blocked" && status?.state !== "error") return undefined;
	const message = status.message?.replace(FORMATTING, "");
	return {
		kind:
			status.state === "error" ? "error" : (status.blocked_kind ?? "blocked"),
		...(status.app === undefined ? {} : { app: status.app }),
		...(message ? { message } : {}),
	};
}
