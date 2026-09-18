import { randomUUID } from "node:crypto";
import {
  backendTransportErrorReport,
  performBackendProfileRequest,
} from "./backend-transport.mjs";

export const GOAL_HELP = `dure goal — continue an explicit goal in the same conversation (Beta)

  dure goal show AGENT_ID [--backend ID]
  dure goal put AGENT_ID --objective TEXT --status active|paused|complete|failed
                       --expected-revision N [--detail TEXT] [--request-id KEY] [--backend ID]

Use revision 0 for the first goal. Read the current revision before changing it.
Active goals continue after successful segments. Pausing stops future continuation;
already admitted work keeps running. Failures are not automatically retried.
Results are JSON. Goal changes and conversation messages use the same Dure backend.`;

export function parseGoalCommand(args) {
  const [action, agentId, ...rest] = args;
  if (!action || ["help", "--help", "-h"].includes(action))
    return { action: "help" };
  if (!["show", "put"].includes(action) || !agentId) throw new Error(GOAL_HELP);
  const options = {};
  const allowed =
    action === "show"
      ? ["--backend"]
      : [
          "--backend",
          "--objective",
          "--status",
          "--expected-revision",
          "--detail",
          "--request-id",
        ];
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (
      !allowed.includes(flag) ||
      Object.hasOwn(options, flag) ||
      rest[index + 1] === undefined
    )
      throw new Error(GOAL_HELP);
    options[flag] = rest[index + 1];
  }
  const expectedRevision = Number(options["--expected-revision"]);
  if (
    action === "put" &&
    (!options["--objective"] ||
      !["active", "paused", "complete", "failed"].includes(
        options["--status"],
      ) ||
      !/^\d+$/u.test(options["--expected-revision"] ?? "") ||
      !Number.isSafeInteger(expectedRevision))
  )
    throw new Error(GOAL_HELP);
  return {
    action,
    agentId,
    backend: options["--backend"],
    body:
      action === "show"
        ? { schemaVersion: 1, agentId }
        : {
            schemaVersion: 1,
            agentId,
            expectedRevision,
            idempotencyKey: options["--request-id"] ?? `goal-${randomUUID()}`,
            objective: options["--objective"],
            status: options["--status"],
            detail: options["--detail"] ?? null,
          },
  };
}

export async function runGoalCommand(
  args,
  {
    resolveBackend,
    requestBackend = performBackendProfileRequest,
    output = (text) => process.stdout.write(`${text}\n`),
  },
) {
  const command = parseGoalCommand(args);
  if (command.action === "help") {
    output(GOAL_HELP);
    return true;
  }
  try {
    const backend = await resolveBackend({
      backend: command.backend,
      backendSpecified: command.backend !== undefined,
    });
    if (backend.error) throw backend.error;
    const response = await requestBackend(
      backend.profile,
      {
        operation:
          command.action === "show" ? "agent_goal.get" : "agent_goal.put",
        body: command.body,
        requiredCapabilities: ["agent_goal.v1"],
      },
      backend.transportOptions,
    );
    output(JSON.stringify(response.result));
    return true;
  } catch (error) {
    output(
      JSON.stringify({
        ...backendTransportErrorReport(error),
        ...(command.action === "put"
          ? { requestId: command.body.idempotencyKey }
          : {}),
      }),
    );
    return false;
  }
}
