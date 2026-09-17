import {
  chmod,
  lstat,
  mkdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const STATE_DIRECTORY = "provider-state";
const CONFIG_DIRECTORY = "codex-home";
const RUNTIME_DIRECTORY = "codex-runtime";
const PRIVATE_MODE = 0o700;
const CODEX_SESSION_NAME = /^dure-media-codex(?:-[a-zA-Z0-9_-]+)?$/u;

function assertBelow(parent, child, label) {
  const pathFromParent = relative(parent, child);
  if (
    pathFromParent === "" ||
    pathFromParent.startsWith("..") ||
    resolve(parent, pathFromParent) !== resolve(child)
  ) {
    throw new Error(`${label} must stay below the provider fixture`);
  }
}

function configuredCodexHome(env) {
  const candidate =
    env.DURE_MEDIA_CODEX_HOME?.trim() ||
    env.CODEX_HOME?.trim() ||
    (env.HOME ? resolve(env.HOME, ".codex") : "");
  if (!candidate || !isAbsolute(candidate)) {
    throw new Error("live Codex capture requires an absolute credential home");
  }
  return candidate;
}

async function canonicalCredential(sourceHome) {
  const sourceMetadata = await lstat(sourceHome);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("live Codex credential home must be one real directory");
  }
  const canonicalHome = await realpath(sourceHome);
  const credential = resolve(canonicalHome, "auth.json");
  const metadata = await lstat(credential);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("live Codex auth.json must be one private regular file");
  }
  return credential;
}

function trustedAutomationConfig(workingDirectory) {
  // Codex merges hooks from every active config layer. A private CODEX_HOME is
  // therefore the boundary; a command-line config override cannot remove them.
  return [
    "check_for_update_on_startup = false",
    'cli_auth_credentials_store = "file"',
    'history.persistence = "none"',
    "",
    `[projects.${JSON.stringify(workingDirectory)}]`,
    'trust_level = "trusted"',
    "",
  ].join("\n");
}

function codexAutomationPaths(fixture, sessionName) {
  if (!CODEX_SESSION_NAME.test(sessionName)) {
    throw new Error("invalid Codex media session name");
  }
  const sessionRoot = resolve(fixture.root, STATE_DIRECTORY, sessionName);
  const configHome = resolve(sessionRoot, CONFIG_DIRECTORY);
  const runtimeHome = resolve(sessionRoot, RUNTIME_DIRECTORY);
  assertBelow(fixture.root, configHome, "Codex automation home");
  assertBelow(fixture.root, runtimeHome, "Codex automation runtime");
  return { configHome, runtimeHome, sessionRoot };
}

async function retireCredential(fixtureRoot, configHome) {
  let homeMetadata;
  try {
    homeMetadata = await lstat(configHome);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!homeMetadata.isDirectory() || homeMetadata.isSymbolicLink()) {
    throw new Error("Codex automation home must remain one real directory");
  }
  assertBelow(
    await realpath(fixtureRoot),
    await realpath(configHome),
    "canonical Codex automation home",
  );
  await chmod(configHome, PRIVATE_MODE);
  const credential = resolve(configHome, "auth.json");
  let metadata;
  try {
    metadata = await lstat(credential);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isDirectory()) {
    throw new Error("refusing directory at Codex automation credential path");
  }
  await unlink(credential);
}

export async function prepareProviderAutomationState({
  env,
  fixture,
  provider,
  sessionName,
  workingDirectory,
}) {
  if (provider !== "codex") {
    return {
      environment: {},
      removals: [],
    };
  }
  const sourceCredential = await canonicalCredential(configuredCodexHome(env));
  if (!workingDirectory || !isAbsolute(workingDirectory)) {
    throw new Error("live Codex capture requires an absolute working directory");
  }
  assertBelow(
    fixture.root,
    workingDirectory,
    "Codex automation working directory",
  );
  const { configHome, runtimeHome, sessionRoot } = codexAutomationPaths(
    fixture,
    sessionName,
  );
  const stateParent = resolve(fixture.root, STATE_DIRECTORY);
  await mkdir(stateParent, { recursive: true, mode: PRIVATE_MODE });
  await mkdir(sessionRoot, { mode: PRIVATE_MODE });
  await Promise.all([
    mkdir(configHome, { mode: PRIVATE_MODE }),
    mkdir(runtimeHome, { mode: PRIVATE_MODE }),
  ]);
  await Promise.all([
    writeFile(
      resolve(configHome, "config.toml"),
      trustedAutomationConfig(workingDirectory),
      {
        flag: "wx",
        mode: 0o600,
      },
    ),
    symlink(sourceCredential, resolve(configHome, "auth.json")),
  ]);
  return {
    environment: {
      CODEX_HOME: configHome,
      CODEX_SQLITE_HOME: runtimeHome,
    },
    removals: ["DURE_MEDIA_CODEX_HOME", "OPENAI_API_KEY"],
  };
}

export function providerAutomationCommand(
  executable,
  args,
  { environment, removals },
) {
  if (removals.length === 0 && Object.keys(environment).length === 0) {
    return [executable, ...args];
  }
  return [
    "/usr/bin/env",
    ...removals.toSorted().flatMap((name) => ["-u", name]),
    ...Object.entries(environment)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`),
    executable,
    ...args,
  ];
}

// Spawn intents are durable before provider state is created, so they remain
// the cleanup authority after an abrupt owner exit without a second registry.
export async function retireProviderAutomationCredentials(
  fixture,
  spawnIntents,
) {
  const sessionNames = new Set(
    spawnIntents
      .filter(
        ({ provider, sessionName }) =>
          provider === "codex" && typeof sessionName === "string",
      )
      .map(({ sessionName }) => sessionName),
  );
  for (const sessionName of sessionNames) {
    const { configHome } = codexAutomationPaths(fixture, sessionName);
    await retireCredential(fixture.root, configHome);
  }
}
