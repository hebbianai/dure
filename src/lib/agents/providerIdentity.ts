import { PROVIDERS, type Provider } from "@/types";

const PROVIDER_BY_COMMAND = new Map<string, Provider>();
for (const id of Object.keys(PROVIDERS) as Provider[]) {
  const spec = PROVIDERS[id];
  const names = [id, spec.cmd.split(" ")[0], ...(spec.detectNames ?? [])];
  for (const name of names) {
    if (name && !PROVIDER_BY_COMMAND.has(name)) {
      PROVIDER_BY_COMMAND.set(name, id);
    }
  }
}

/** Resolve a provider from one reported executable path or provider id. */
export function providerFromCommand(
  command: string | null | undefined,
): Provider | null {
  const name = (command ?? "").trim().split("/").pop() ?? "";
  return name ? (PROVIDER_BY_COMMAND.get(name) ?? null) : null;
}

/** Fail-closed migration for old pane layouts that persisted only a simple
 * provider executable plus arguments. Shell pipelines and env prefixes remain
 * opaque because their credential identity cannot be recovered safely. */
export function providerFromLegacyLaunchCommand(
  command: string | null | undefined,
): Provider | null {
  const simple = command?.trim();
  if (!simple || /[|;&<>`$\n\r]/.test(simple)) return null;
  const executable = simple.match(/^([A-Za-z0-9_./-]+)(?:\s|$)/)?.[1];
  return executable ? providerFromCommand(executable) : null;
}
