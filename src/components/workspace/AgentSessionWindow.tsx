import { NativeAgentResponseView } from "@/components/agents/NativeAgentResponseView";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { PanelStatus } from "@/components/common/PanelStatus";
import { Titled } from "@/components/ui/tooltip";
import { TerminalView } from "@/components/terminal/TerminalView";
import { AgentSessionWindowToolbar } from "@/components/workspace/AgentSessionWindowToolbar";
import {
  SecondaryWindowShell,
  useSecondaryWindowBoot,
  windowChromeDragHandler,
} from "@/components/workspace/SecondaryWindowShell";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { t } from "@/lib/i18n";
import { preloadTerminalFont } from "@/lib/terminal/renderer/terminalFontPreload";
import {
  beginTerminalDocumentResize,
  finishTerminalDocumentResize,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import { bindTerminalNativeWindowResize } from "@/lib/terminal/geometry/terminalNativeWindowResize";
import type { TerminalWindowFocusProbe } from "@/lib/terminal/terminalWindowFocusProbe";
import { isHmuxPaneBinding } from "@/lib/terminal/terminalBinding";
import { useNativeWindowTheme } from "@/lib/platform/windowAppearance";
import { useResolvedDark } from "@/lib/theme/themePreference";
import { toggleWindowMaximizeAtomic } from "@/lib/ipc/system";
import { agentSessionWindowBinding } from "@/lib/workspace/window/agentSessionWindowTarget";
import { agentPaneTitle } from "@/lib/workspace/pane/paneTitle";
import { useTerminalFontShortcut } from "@/lib/workspace/window/windowShortcutHooks";
import {
  restoreWindowAfterSecondaryClose,
  useNativeShellGlass,
  useNativeTrafficLightDrop,
} from "@/lib/workspace/window/windows";
import {
  revealSecondaryWindow,
  SECONDARY_WINDOW_CLOSE_TIMEOUT_MS,
  withSecondaryWindowTimeout,
} from "@/lib/workspace/window/secondaryWindowOperation";
import {
  type AgentSessionSource,
  currentAgentSessionSource,
  normalizeAgentSessionSourcePaneOwnerId,
  normalizeAgentSessionSourceWindowLabel,
  publishAgentSessionRuntimeState,
  setAgentSessionSourceOpen,
  subscribeAgentSessionSource,
} from "@/lib/workspace/window/agentSessionWindowSource";
import { beginLargeViewReturnToWindow } from "@/lib/workspace/window/largeViewReturnHandoff";
import { LargeViewSurfaceRetirementDrain } from "@/lib/workspace/window/largeViewReturnTransaction";
import {
  shellChromeClass,
  shellEdgeOverlayClass,
  useWindowShellShape,
} from "@/lib/workspace/window/windowShellShape";
import { useDurableWindowClose } from "@/lib/workspace/window/useDurableWindowClose";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import type { Agent } from "@/types";

/**
 * ?sessionWindow=<agentId>로 열린 Hmux 세션의 단독 큰 창.
 *
 * Dockview pane을 옮기거나 복제하지 않는다. 이 창이 살아 있는 동안 원본 pane은
 * renderer를 내려놓고 이 창을 앞으로 가져오는 proxy로만 남는다.
 */
export function AgentSessionWindowRoot({
  agentId,
  sourceWindowLabel = "main",
  sourcePaneOwnerId,
  windowFocusProbe,
  agentOverride,
}: {
  agentId: string;
  sourceWindowLabel?: string;
  sourcePaneOwnerId?: string;
  /** Development-only native lifecycle probe used by the real-window QA. */
  windowFocusProbe?: TerminalWindowFocusProbe;
  /** Development-only durable-store-independent agent used by native QA. */
  agentOverride?: Agent;
}) {
  useNativeWindowTheme();
  const fullscreen = useWindowShellShape();
  useNativeShellGlass(fullscreen, useResolvedDark());
  useNativeTrafficLightDrop(fullscreen);
  const storedAgent = useStore((state) =>
    state.agents.find((candidate) => candidate.id === agentId),
  );
  const agent = agentOverride ?? storedAgent;
  // Shared secondary-window boot (dark class, language, keyboard focus,
  // store sync) — the native title follows the agent name too.
  const lang = useSecondaryWindowBoot(
    agent ? `Dure — ${agentDisplayName(agent)}` : "Dure",
  );
  const agentCwd = useStore((state) =>
    agent ? state.sessionCwd[agent.sessionId] : undefined,
  );
  const binding = agent ? agentSessionWindowBinding(agent) : undefined;
  const largeViewAvailable = Boolean(binding);
  const structuredBinding =
    isHmuxPaneBinding(binding) && binding.source === "local"
      ? binding
      : undefined;
  const returnIdentity = isHmuxPaneBinding(binding)
    ? { workspaceId: binding.workspaceId, sessionId: binding.sessionId }
    : undefined;
  const [closing, setClosing] = useState(false);
  const [toolbarSource, setToolbarSource] = useState<AgentSessionSource>(() => ({
    windowLabel: normalizeAgentSessionSourceWindowLabel(sourceWindowLabel),
    paneOwnerId: normalizeAgentSessionSourcePaneOwnerId(sourcePaneOwnerId),
  }));
  const [readySessionId, setReadySessionId] = useState<string>();
  const largeViewReady = binding?.sessionId === readySessionId;
  const initialGeometryGenerationRef = useRef<number | undefined>(undefined);
  const structuredSurfaceRetirementsRef = useRef(
    new LargeViewSurfaceRetirementDrain(),
  );
  const closeReturnSourceRef = useRef<AgentSessionSource | undefined>(undefined);
  const disposedRef = useRef(false);
  const sourceRef = useRef<AgentSessionSource>({
    windowLabel: normalizeAgentSessionSourceWindowLabel(sourceWindowLabel),
    paneOwnerId: normalizeAgentSessionSourcePaneOwnerId(sourcePaneOwnerId),
  });

  useLayoutEffect(() => {
    if (!structuredBinding) return;
    const generation = beginTerminalDocumentResize(
      document,
      structuredBinding.sessionId,
    );
    initialGeometryGenerationRef.current = generation;
    return () => {
      if (initialGeometryGenerationRef.current !== generation) return;
      initialGeometryGenerationRef.current = undefined;
      finishTerminalDocumentResize(document, "surface_ready", generation);
    };
  }, [structuredBinding?.sessionId]);

  useEffect(() => {
    if (!structuredBinding) return;
    return bindTerminalNativeWindowResize(
      document,
      structuredBinding.sessionId,
    );
  }, [structuredBinding?.sessionId]);

  const onGeometryObserved = useCallback(() => {
    if (binding?.sessionId) setReadySessionId(binding.sessionId);
    const generation = initialGeometryGenerationRef.current;
    if (generation === undefined) return;
    initialGeometryGenerationRef.current = undefined;
    finishTerminalDocumentResize(document, "surface_ready", generation);
  }, [binding?.sessionId]);
  const onStructuredSurfaceRetirement = useCallback(
    (retirement: Promise<void>) => {
      structuredSurfaceRetirementsRef.current.report(retirement);
    },
    [],
  );
  useEffect(() => {
    preloadTerminalFont(useStore.getState().uiPrefs?.terminalFontFamily ?? "");
  }, []);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);
  useTerminalFontShortcut();

  useEffect(() => {
    const source = {
      windowLabel: normalizeAgentSessionSourceWindowLabel(sourceWindowLabel),
      paneOwnerId: normalizeAgentSessionSourcePaneOwnerId(sourcePaneOwnerId),
    };
    sourceRef.current = source;
    setToolbarSource(source);
  }, [sourcePaneOwnerId, sourceWindowLabel]);

  useEffect(() => {
    if (!largeViewAvailable) return;
    setAgentSessionSourceOpen(agentId, toolbarSource, largeViewReady);
    return () => setAgentSessionSourceOpen(agentId, toolbarSource, false);
  }, [agentId, largeViewAvailable, largeViewReady, toolbarSource]);

  useEffect(
    () =>
      subscribeAgentSessionSource(agentId, (source) => {
        setAgentSessionSourceOpen(agentId, sourceRef.current, false);
        sourceRef.current = source;
        setToolbarSource(source);
      }),
    [agentId],
  );

  useEffect(() => {
    if (!binding) return;
    const publish = () => {
      const runtimeState =
        useStore.getState().sessionAgentRuntimeState[binding.sessionId];
      if (!runtimeState) return;
      void publishAgentSessionRuntimeState(
        toolbarSource.windowLabel,
        binding.sessionId,
        runtimeState,
      ).catch(() => {});
    };
    publish();
    return useStore.subscribe((state, previous) => {
      if (
        state.sessionAgentRuntimeState[binding.sessionId] ===
        previous.sessionAgentRuntimeState[binding.sessionId]
      ) {
        return;
      }
      publish();
    });
  }, [binding?.sessionId, toolbarSource.windowLabel]);

  useDurableWindowClose({
    enabled: Boolean(returnIdentity),
    prepare: async () => {
      if (!returnIdentity) return;
      const win = getCurrentWindow();
      const returnSource = currentAgentSessionSource(
        agentId,
        sourceRef.current,
      );
      closeReturnSourceRef.current = returnSource;
      try {
        await withSecondaryWindowTimeout(
          "large view native conceal",
          win.hide(),
          SECONDARY_WINDOW_CLOSE_TIMEOUT_MS,
        );
      } catch (error) {
        console.warn("[large-view] failed to conceal before close", error);
      }
      setAgentSessionSourceOpen(agentId, returnSource, false);
      // The source must cover its retained large grid before its workspace
      // window becomes visible. This acknowledgement is bounded and fails open
      // if that exact originating window is no longer available.
      const preparedReturn = await beginLargeViewReturnToWindow(
        {
          ...returnIdentity,
          ...(returnSource.paneOwnerId
            ? { sourcePaneOwnerId: returnSource.paneOwnerId }
            : {}),
        },
        win.label,
        returnSource.windowLabel,
      );
      // The native close request is outside React's event system. Commit the
      // TerminalView unmount before waiting for its exact structured
      // attachment to retire from the Host geometry proposal set.
      flushSync(() => setClosing(true));
      let largeSurfaceRetired = true;
      try {
        await withSecondaryWindowTimeout(
          "large view structured surface retirement",
          structuredSurfaceRetirementsRef.current.wait(),
          SECONDARY_WINDOW_CLOSE_TIMEOUT_MS,
        );
      } catch (error) {
        largeSurfaceRetired = false;
        console.warn(
          "[hmux] failed to retire the large structured surface",
          error,
        );
      }
      if (preparedReturn && largeSurfaceRetired) {
        await withSecondaryWindowTimeout(
          "large view surface retirement signal",
          preparedReturn.markLargeSurfaceRetired(),
          SECONDARY_WINDOW_CLOSE_TIMEOUT_MS,
        ).catch((error) => {
          console.warn(
            "[hmux] failed to confirm the large-view surface retirement",
            error,
          );
        });
      }
      // Retire the large surface before focusing the originating window so the
      // Host resolves geometry from the source pane's proposal alone.
      await restoreWindowAfterSecondaryClose(returnSource.windowLabel).catch(
        () => {},
      );
    },
    close: () =>
      withSecondaryWindowTimeout(
        "large view native close",
        getCurrentWindow().close(),
        SECONDARY_WINDOW_CLOSE_TIMEOUT_MS,
      ),
    onFailure: async (error) => {
      const returnSource = closeReturnSourceRef.current;
      if (returnSource) {
        setAgentSessionSourceOpen(agentId, returnSource, true);
        if (!disposedRef.current) {
          flushSync(() => setClosing(false));
          await revealSecondaryWindow(getCurrentWindow()).catch((revealError) => {
            console.warn(
              "[large-view] failed to reveal after close failure",
              revealError,
            );
          });
        }
      }
      console.error("[large-view] failed to close window", error);
    },
  });

  const heading = agent
    ? agentPaneTitle(agentDisplayName(agent), agentCwd, agent.worktreePath)
    : t("common.agentDeleted");

  // Double-click maximize wraps the native toggle in a terminal document
  // resize transaction — this stays here, never inside the shared shell.
  const onHeaderMouseDown = windowChromeDragHandler(() => {
    if (!binding) {
      getCurrentWindow().toggleMaximize().catch(() => {});
      return;
    }
    const generation = beginTerminalDocumentResize(document, binding.sessionId);
    void toggleWindowMaximizeAtomic()
      .catch(() => {})
      .finally(() => {
        finishTerminalDocumentResize(document, "native_window", generation);
      });
  });
  const shellEdgeOverlay = shellEdgeOverlayClass(fullscreen);

  return (
    <SecondaryWindowShell
      key={lang}
      className={cn("relative overflow-hidden", shellChromeClass(fullscreen))}
    >
      <header
        data-tauri-drag-region
        className="z-10 flex h-[var(--app-chrome-bar-height)] shrink-0 items-center border-b border-border/60 bg-sidebar pr-3 pl-[82px] text-sidebar-foreground select-none"
        onMouseDown={onHeaderMouseDown}
      >
        <Titled title={heading}>
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium"
          >
            {heading}
          </span>
        </Titled>
      </header>
      {agent && binding && !closing && (
        <AgentSessionWindowToolbar
          agent={agent}
          binding={binding}
          sourceWindowLabel={toolbarSource.windowLabel}
          sourcePaneOwnerId={toolbarSource.paneOwnerId}
        />
      )}
      <div className="relative min-h-0 flex-1">
        {agent && binding && !closing ? (
          <NativeAgentResponseView agent={agent}>
            <TerminalView
              sessionId={binding.sessionId}
              providerHint={agent.provider}
              surfaceId={`agent-session:${agentId}`}
              kind={agent.sessionKind}
              binding={binding}
              runtimeWorkingDirectory={agent.worktreePath}
              windowFocusProbe={windowFocusProbe}
              onGeometryObserved={onGeometryObserved}
              onStructuredSurfaceRetirement={onStructuredSurfaceRetirement}
            />
          </NativeAgentResponseView>
        ) : (
          <PanelStatus>
            {agent
              ? t("workspace.agentWindow.unavailable")
              : t("common.agentDeleted")}
          </PanelStatus>
        )}
      </div>
      {/* 창 경계 — 자식이 가장자리까지 채워 루트 inset 그림자를 덮으므로
          경계선은 맨 위 오버레이가 그린다(windowShellShape 주석). */}
      {shellEdgeOverlay && <div aria-hidden className={shellEdgeOverlay} />}
    </SecondaryWindowShell>
  );
}
