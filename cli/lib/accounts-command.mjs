import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import { PROVIDERS } from "./contracts/provider-catalog.mjs";

const REGISTER_OPERATION = "provider_credential_profile.register";
const PROFILE_DIRECTORY_NAME = /^[A-Za-z0-9_-]{1,160}$/u;
const HELP_ARGUMENTS = new Set(["help", "--help", "-h"]);

export const ACCOUNTS_HELP = `dure accounts — register a provider login already signed in on a backend host

  dure accounts register PROVIDER --dir NAME [--backend ID] [--json]

Sign in on the backend host first, with the provider's own CLI pointed at a
directory named PROVIDER-something under that host's ~/.dure/accounts:

  mkdir -p ~/.dure/accounts/codex-work
  chmod 700 ~/.dure/accounts ~/.dure/accounts/codex-work
  CODEX_HOME=~/.dure/accounts/codex-work codex login --device-auth
  CLAUDE_CONFIG_DIR=~/.dure/accounts/claude-work claude auth login

Both folders must belong to the backend's user and be closed to other users.
NAME is the directory name, not a path, and it is also the account ID, so
running the command again keeps the same ID. Without --backend it uses the
default backend, normally local.

Use the ID with dure run --account ID or dure runs switch-account RUN --account
ID on the same backend; dure recovery get PROVIDER lists it. A directory the app
already registered keeps its app account ID; use that ID instead.

Dure does not run the sign-in and never copies credentials between machines.
The desktop app's account list does not show accounts registered this way yet.`;

function validProfileDirectory(providerId, directory) {
  const prefix = `${providerId}-`;
  return PROFILE_DIRECTORY_NAME.test(directory) && directory.startsWith(prefix) &&
    directory.length > prefix.length;
}

export function parseAccountsCommand(args) {
  const [action, ...rest] = args;
  if (!action || HELP_ARGUMENTS.has(action) || rest.some((value) => HELP_ARGUMENTS.has(value))) {
    return { action: "help" };
  }
  const providerId = rest.shift();
  if (action !== "register" || !isDureDomainIdV1(providerId)) throw new Error(ACCOUNTS_HELP);
  const options = {};
  let json = false;
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag === "--json") {
      json = true;
      index -= 1;
      continue;
    }
    if (!["--dir", "--backend"].includes(flag) || Object.hasOwn(options, flag) ||
        rest[index + 1] === undefined) throw new Error(ACCOUNTS_HELP);
    options[flag] = rest[index + 1];
  }
  const directory = options["--dir"];
  if (directory === undefined) throw new Error(ACCOUNTS_HELP);
  if (!validProfileDirectory(providerId, directory)) {
    throw new Error(`--dir takes one directory name under the backend's accounts folder, ` +
      `such as ${providerId}-work, not a path. It must start with ${providerId}- and use only ` +
      "letters, digits, - and _.");
  }
  return { action, providerId, directory, backend: options["--backend"], json };
}

function signInLines(providerId, directory) {
  const path = `~/.dure/accounts/${directory}`;
  const provider = Object.hasOwn(PROVIDERS, providerId) ? PROVIDERS[providerId] : undefined;
  const login = provider?.remoteLoginCmd ?? provider?.loginCmd;
  return [`  mkdir -p ${path}`, `  chmod 700 ~/.dure/accounts ${path}`,
    ...(provider?.configEnv && login ? [`  ${provider.configEnv}=${path} ${login}`] : [])];
}

function failureGuidance({ remoteCode }, { providerId, directory }, backendId) {
  if (remoteCode === "provider_credential_profile_unavailable") {
    return [`Directory ${directory} is not ready on backend ${backendId}. It must exist under ` +
      "that host's ~/.dure/accounts, belong to the backend's user, and be closed to other users.",
    "On the backend host, sign in with the provider's own CLI, then run this command again:",
    ...signInLines(providerId, directory)].join("\n");
  }
  if (remoteCode === "provider_credential_profile_conflict") {
    return `${directory} is already registered differently on backend ${backendId}, usually ` +
      "because the app registered this directory under its own account ID. That account keeps " +
      `working; dure recovery get ${providerId} --backend ${backendId} lists its ID.`;
  }
  return undefined;
}

function registeredProfile(result, { providerId, directory }) {
  const profile = result?.profile;
  return result?.schemaVersion === 1 && profile?.schemaVersion === 1 &&
    profile.providerId === providerId && profile.referenceId === directory &&
    isDureDomainIdV1(profile.credentialGeneration);
}

/** Registers a directory the operator already signed in on the backend host.
 * This adapter sends names only: it owns no sign-in, credential bytes or
 * account list. The backend validates the directory and keeps its generation. */
export async function runAccountsCommand(args, {
  resolveBackend,
  requestBackend = performBackendProfileRequest,
  output = (text) => process.stdout.write(`${text}\n`),
  errorOutput = (text) => process.stderr.write(`${text}\n`),
}) {
  const command = parseAccountsCommand(args);
  if (command.action === "help") {
    output(ACCOUNTS_HELP);
    return true;
  }
  const { providerId, directory, json } = command;
  const refuse = (failure, profile) => {
    const guidance = failureGuidance(failure, command, profile?.id);
    if (json) {
      output(JSON.stringify({ schemaVersion: 1, kind: "dure.accounts.error", action: "register",
        complete: false, error: { ...failure, ...(profile ? { profileId: profile.id } : {}),
          ...(guidance ? { guidance } : {}) } }));
    } else errorOutput(guidance ?? `Could not register ${directory}: ${failure.message}`);
    return false;
  };
  let backend;
  try {
    backend = await resolveBackend({ backend: command.backend,
      backendSpecified: command.backend !== undefined });
    if (backend.error) throw backend.error;
    const { result } = await requestBackend(backend.profile, {
      operation: REGISTER_OPERATION, requiredCapabilities: [REGISTER_OPERATION],
      body: { schemaVersion: 1, providerId, referenceId: directory, profileDirectoryName: directory },
    }, backend.transportOptions);
    if (!registeredProfile(result, command)) {
      return refuse({ code: "accounts_register_response_invalid",
        message: "The backend returned an invalid account registration." }, backend.profile);
    }
    const backendId = backend.profile.id;
    output(json ? JSON.stringify(result) : [
      `Registered ${providerId} account ${directory} on backend ${backendId}.`,
      `Switch a Run to it: dure runs switch-account RUN --account ${directory} --backend ${backendId} --confirm-restart`,
    ].join("\n"));
    return true;
  } catch (error) {
    return refuse(backendRequestFailure(error, backend?.profile), backend?.profile);
  }
}
