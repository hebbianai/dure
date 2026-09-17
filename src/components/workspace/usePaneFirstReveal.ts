import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { useStore } from "@/store";
import { visibleActiveDesktopId } from "@/lib/workspace/desktop/activeDesktop";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";

/**
 * true from the moment the pane has actually been visible to the user once:
 * visible tab in its Dockview group AND its desktop is the active one. Gating
 * mount-time work (git spawns, network loads) on this keeps hidden tabs and
 * off-screen/frozen spaces from paying it during a cold desktop remount —
 * the work runs at first reveal instead. Latches true; never reverts.
 *
 * Outside a workspace runtime (popped-out window) only tab visibility gates.
 */
export function usePaneFirstReveal(api: IDockviewPanelProps["api"]): boolean {
  const desktopId = useWorkspaceRuntimeDesktopId();
  // WorkspaceDeck 렌더와 동일한 폴백(visibleActiveDesktopId) — raw
  // activeSpaceId가 stale하면 화면에 보이는 데스크탑과 게이트가 어긋난다.
  const activeSpaceId = useStore((s) =>
    visibleActiveDesktopId(s.spaces, s.activeSpaceId),
  );
  const desktopActive = !desktopId || activeSpaceId === desktopId;
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (revealed || !desktopActive) return;
    const check = () => {
      if (api.isVisible) setRevealed(true);
    };
    check();
    const visibility = api.onDidVisibilityChange(check);
    return () => visibility.dispose();
  }, [revealed, desktopActive, api]);

  return revealed;
}
