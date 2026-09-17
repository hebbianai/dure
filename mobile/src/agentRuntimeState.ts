/**
 * What the attached agent is doing, as the relay tells this phone.
 *
 * The gateway seeds every relayed structured attach with the agent's runtime
 * state and forwards each change as a JSON control record beside the binary
 * viewport frames. The literals mirror `HmuxAgentRuntimeState` in
 * `src/lib/ipc/hmuxContracts.ts`; the mobile record arrives raw (snake_case,
 * `u64` counters as decimal strings), so it is parsed here once into a typed
 * value and never re-validated downstream.
 */

export type AgentAttention = "none" | "input_required" | "approval_required" | "error";

export interface AgentRuntimeState {
  readonly lifecycle: "starting" | "running" | "exited";
  readonly activity: "working" | "waiting";
  readonly attention: AgentAttention;
  /** The identity of the moment that wants attention — an approval's id, while one is pending. */
  readonly attentionId?: string;
  /** Host revision, `u64` as a decimal string. */
  readonly revision: string;
  /**
   * Host turn counter, `u64` as a decimal string. The Host omits it on the
   * wire while it is zero and defines absence as zero, so it is always known
   * here: `"0"` until the first turn ends.
   */
  readonly turnCompletedCount: string;
}

/**
 * The identity of the approval a state waits on, or none. The Host names
 * every approval; if one ever arrives unnamed, its revision keeps it distinct
 * from the last one rather than letting it ride on that one's proof or
 * notice. The one rule for both the Face ID gate and the notifier.
 */
export function approvalIdentity(state: AgentRuntimeState): string | undefined {
  if (state.attention !== "approval_required") return undefined;
  return state.attentionId ?? `revision:${state.revision}`;
}

const LIFECYCLES: ReadonlySet<AgentRuntimeState["lifecycle"]> = new Set([
  "starting",
  "running",
  "exited",
]);
const ACTIVITIES: ReadonlySet<AgentRuntimeState["activity"]> = new Set(["working", "waiting"]);
const ATTENTIONS: ReadonlySet<AgentAttention> = new Set([
  "none",
  "input_required",
  "approval_required",
  "error",
]);

/**
 * Recognises exactly `{kind:"control",body:{kind:"agent_runtime_state",payload}}`.
 *
 * Null for anything else — viewport bytes, exit and error notices, a closed
 * record, malformed JSON — so the caller can try it first and fall through.
 * Never throws.
 */
export function parseAgentRuntimeRecord(bytes: Uint8Array): AgentRuntimeState | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const payload = runtimePayload(value);
  if (!payload) return null;

  const { lifecycle, activity, attention, revision } = payload;
  if (
    !isOneOf(LIFECYCLES, lifecycle) ||
    !isOneOf(ACTIVITIES, activity) ||
    !isOneOf(ATTENTIONS, attention) ||
    typeof revision !== "string"
  ) {
    return null;
  }
  const attentionId = optionalString(payload, "attention_id");
  const turnCompletedCount = optionalString(payload, "turn_completed_count");
  if (attentionId === null || turnCompletedCount === null) return null;

  return {
    lifecycle,
    activity,
    attention,
    ...(attentionId === undefined ? {} : { attentionId }),
    revision,
    turnCompletedCount: turnCompletedCount ?? "0",
  };
}

function runtimePayload(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || value.kind !== "control") return null;
  const body = value.body;
  if (!isRecord(body) || body.kind !== "agent_runtime_state") return null;
  return isRecord(body.payload) ? body.payload : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(set: ReadonlySet<T>, value: unknown): value is T {
  return typeof value === "string" && (set as ReadonlySet<string>).has(value);
}

/** `undefined` when absent, `null` when present but not a string. */
function optionalString(record: Record<string, unknown>, key: string): string | undefined | null {
  if (!(key in record) || record[key] === null || record[key] === undefined) return undefined;
  return typeof record[key] === "string" ? record[key] : null;
}
