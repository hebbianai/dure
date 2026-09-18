import { randomUUID } from "node:crypto";
import { backendTransportErrorReport, performBackendProfileRequest } from "./backend-transport.mjs";

export const ENVIRONMENT_HELP = `dure environment — provision worktree compute from a repository recipe (Beta)

  dure environment list
  dure environment recipes --project PATH
  dure environment create --project PATH --recipe ID --digest SHA256 --name NAME [--request-id KEY]
  dure environment suspend|resume|destroy --id ID --revision N [--request-id KEY]

Recipes run on the local backend.
Create returns a durable pending record; use list to observe completion.
Destroy deletes provider resources, including files and running sessions.
Keep the same request ID when retrying an uncertain create.`;

export function parseEnvironmentCommand(args) {
  const [action, ...rest] = args;
  if (!action || ["help", "--help", "-h"].includes(action)) return { action: "help" };
  const allowed = {
    list: [], recipes: ["--project"],
    create: ["--project", "--recipe", "--digest", "--name", "--request-id"],
    suspend: ["--id", "--revision", "--request-id"],
    resume: ["--id", "--revision", "--request-id"],
    destroy: ["--id", "--revision", "--request-id"],
  }[action];
  if (!Array.isArray(allowed)) throw new Error(ENVIRONMENT_HELP);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!allowed.includes(flag) || Object.hasOwn(options, flag) || !rest[index + 1]) throw new Error(ENVIRONMENT_HELP);
    options[flag] = rest[index + 1];
  }
  const base = { schemaVersion: 1 };
  if (action === "list") return { action, body: { ...base, action } };
  if (["recipes", "create"].includes(action)) {
    if (!options["--project"]?.startsWith("/")) throw new Error(ENVIRONMENT_HELP);
    if (action === "recipes") return { action, body: { ...base, action, projectPath: options["--project"] } };
    if (!options["--recipe"] || !/^sha256:[0-9a-f]{64}$/u.test(options["--digest"] ?? "") || !options["--name"]?.trim()) throw new Error(ENVIRONMENT_HELP);
    return { action, body: { ...base, action, projectPath: options["--project"], recipeId: options["--recipe"],
      recipeDigest: options["--digest"], name: options["--name"], idempotencyKey: options["--request-id"] ?? randomUUID() } };
  }
  const revision = Number(options["--revision"]);
  if (!/^env-[0-9a-f]{64}$/u.test(options["--id"] ?? "") || !/^[1-9][0-9]*$/u.test(options["--revision"] ?? "") || !Number.isSafeInteger(revision)) throw new Error(ENVIRONMENT_HELP);
  return { action, body: { ...base, action: "transition", operation: action, id: options["--id"],
    expectedRevision: revision, idempotencyKey: options["--request-id"] ?? randomUUID() } };
}

export async function runEnvironmentCommand(args, {
  resolveBackend, requestBackend = performBackendProfileRequest,
  output = (text) => process.stdout.write(`${text}\n`),
}) {
  const command = parseEnvironmentCommand(args);
  if (command.action === "help") { output(ENVIRONMENT_HELP); return true; }
  try {
    const backend = await resolveBackend({ backend: "local", backendSpecified: true });
    if (backend.error) throw backend.error;
    const response = await requestBackend(backend.profile, {
      operation: "workspace_environment.invoke", body: command.body,
      requiredCapabilities: ["workspace_environment.v1"],
    }, backend.transportOptions);
    output(JSON.stringify({ ...response.result, ...(command.body.idempotencyKey ? { requestId: command.body.idempotencyKey } : {}) }));
    return true;
  } catch (error) {
    output(JSON.stringify({ ...backendTransportErrorReport(error),
      ...(command.body.idempotencyKey ? { requestId: command.body.idempotencyKey } : {}) }));
    return false;
  }
}
