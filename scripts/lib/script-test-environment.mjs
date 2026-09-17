const PASSTHROUGH_VARIABLES = new Set([
  "COMSPEC",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "COREPACK_HOME",
  "COREPACK_ROOT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
]);

/** Build a deterministic child-process boundary for script fixtures. */
export function scriptTestEnvironment(overrides = {}, source = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      typeof value === "string" &&
      PASSTHROUGH_VARIABLES.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = String(value);
    }
  }
  return environment;
}
