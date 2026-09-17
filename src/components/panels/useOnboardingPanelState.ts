// OnboardingPanel's designated store-wiring point (cluster wiring hook).
// Every global-store subscription the onboarding pane needs lives here; the
// component consumes the returned values and keeps rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { useStore } from "@/store";
import type { Provider } from "@/types";

export function useOnboardingPanelState() {
  const projects = useStore((s) => s.projects);
  const installedAgents = useStore((s) => s.installedAgents);
  const accounts = useStore((s) => s.accounts);
  const activeAccounts = useStore((s) => s.activeAccounts);
  return {
    projects,
    installedAgents,
    accounts,
    activeAccounts,
    publishInstalledAgents,
  };
}

// Call-time store write used by the re-probe effect — wraps exactly the
// useStore.getState() access the component previously inlined. Module-scope
// so its identity is stable across renders.
function publishInstalledAgents(providers: Provider[]) {
  useStore.getState().setInstalledAgents(providers);
}
