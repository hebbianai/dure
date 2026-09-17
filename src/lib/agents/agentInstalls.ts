import { useMemo } from "react";
import { runShell } from "@/lib/ipc/process";
import { providerExecutable } from "@/lib/agents/providerPreflight";
import { quickStartProviders } from "@/lib/agents/providerQuickStart";
import { PROVIDER_IDS } from "@/lib/agents/providers";
import { providersForInterfaceMode } from "@/lib/agents/providerCatalog";
import { resolveEffectiveInterfaceMode } from "@/lib/workspace/pane/interfaceMode";
import { homeDir, providerPreflight } from "@/lib/ipc";
import {
  type DesktopPlatform,
  detectDesktopPlatform,
} from "@/lib/workspace/desktop/desktopPlatform";
import { useStore } from "@/store";
import { PROVIDERS, type Provider } from "@/types";

const WINDOWS_PREFLIGHT_CONCURRENCY = 4;

/** Windows owns executable discovery in the native preflight adapter. A
 * login-shell `command -v` probe can accidentally launch the WSL app alias and
 * report an empty result even when a native CLI is already on PATH. */
async function detectWindowsInstalledProviders(): Promise<Provider[]> {
  const cwd = await homeDir();
  const queue = [...PROVIDER_IDS];
  const installed = new Set<Provider>();
  const failures: unknown[] = [];

  const probeNext = async (): Promise<void> => {
    const provider = queue.shift();
    if (!provider) return;
    try {
      const result = await providerPreflight({
        provider,
        command: providerExecutable(provider),
        cwd,
      });
      const spec = PROVIDERS[provider];
      if (
        result.executable &&
        (!spec.installationProbeRequiresReady || result.ready)
      ) {
        installed.add(provider);
      }
    } catch (error) {
      failures.push(error);
    }
    await probeNext();
  };

  await Promise.all(
    Array.from(
      { length: Math.min(WINDOWS_PREFLIGHT_CONCURRENCY, queue.length) },
      probeNext,
    ),
  );
  if (failures.length > 0) throw failures[0];
  return PROVIDER_IDS.filter((provider) => installed.has(provider));
}

/** PATH에 실제로 있는 에이전트 CLI를 한 번에 훑는다(로그인 셸 PATH 기준).
 *  `continue`처럼 셸 키워드와 이름이 겹치는 경우가 있어 절대경로만 설치로 친다. */
export async function detectInstalledProviders(
  platform: DesktopPlatform = detectDesktopPlatform(),
): Promise<Provider[]> {
  if (platform === "windows") return detectWindowsInstalledProviders();
  const binaries = PROVIDER_IDS.map((id) => [id, PROVIDERS[id].cmd.split(" ")[0]] as const);
  const script = binaries
    .map(([id, bin]) => `printf '%s\\t%s\\n' ${id} "$(command -v -- ${bin} 2>/dev/null)"`)
    .join("; ");
  const out = await runShell(script).catch(() => null);
  if (!out) return [];
  const found = new Set(
    out.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .filter(([, path]) => path?.startsWith("/"))
      .map(([id]) => id),
  );
  return PROVIDER_IDS.filter((id) => found.has(id));
}

/** The rollout catalog includes uninstalled providers for SSH and setup offers. */
export function visibleProviders(): Provider[] {
  return providersForInterfaceMode(
    resolveEffectiveInterfaceMode(useStore.getState().uiPrefs?.interfaceMode).mode,
  );
}

export function useVisibleProviders(): Provider[] {
  const mode = useStore(
    (state) => resolveEffectiveInterfaceMode(state.uiPrefs?.interfaceMode).mode,
  );
  return useMemo(() => providersForInterfaceMode(mode), [mode]);
}

/** Core providers remain discoverable before installation; all others need
 * installation evidence as well as rollout approval for the current mode. */
function filterAvailable(visible: Provider[], installed: Provider[]): Provider[] {
  const found = new Set(installed);
  return visible.filter((id) => PROVIDERS[id].core || found.has(id));
}

export function availableProviders(): Provider[] {
  return filterAvailable(visibleProviders(), useStore.getState().installedAgents);
}

export function useAvailableProviders(): Provider[] {
  const installed = useStore((s) => s.installedAgents);
  const visible = useVisibleProviders();
  return useMemo(() => filterAvailable(visible, installed), [visible, installed]);
}

/** The menu's providers plus the prefix of them that earns a button, for
 *  surfaces that show a few inline and keep the rest one hover away. Both come
 *  from the same list, so a button can never offer what the menu does not. */
export function useQuickStartProviders(limit: number): {
  available: Provider[];
  quick: Provider[];
} {
  const installed = useStore((s) => s.installedAgents);
  const visible = useVisibleProviders();
  return useMemo(() => {
    const available = filterAvailable(visible, installed);
    return { available, quick: quickStartProviders(available, installed, limit) };
  }, [visible, installed, limit]);
}

/** 설치되어 있고 bundled delegation adapter까지 있는 provider만 남긴다. */
export function useWorkflowDelegateProviders(current?: Provider): Provider[] {
	const installed = useStore((state) => state.installedAgents);
	const visible = useVisibleProviders();
	return useMemo(
		() =>
			visible.filter(
				(provider) =>
					PROVIDERS[provider].workflowDelegate === true &&
					(provider === current || installed.includes(provider)),
			),
		[current, installed, visible],
	);
}
