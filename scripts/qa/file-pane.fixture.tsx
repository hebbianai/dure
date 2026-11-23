import { createRoot } from "react-dom/client";
import { DockviewReact, type DockviewApi } from "dockview-react";
import { FileViewerPanel } from "@/components/files/FileViewerPanel";
import { MockupPanel } from "@/components/panels/MockupPanel";
import { dispatchCliDesktopPaneRequest } from "@/lib/cli/cliDesktopPaneLifecycle";
import { openLocalFilePane } from "@/lib/files/localFilePane";
import { registerDockview } from "@/lib/workspace/dock/dockRegistry";
import { ensureLangLoaded } from "@/lib/i18n";
import { useStore } from "@/store";
import "dockview-react/dist/styles/dockview.css";
import "@/index.css";

// Real CLI dispatcher, Store, Dockview and file renderers. The browser runner
// supplies a bounded read-only IPC fixture; there are no native processes.
await ensureLangLoaded("en");
useStore.setState({ spaces: [{ id: "review", name: "Review" }], activeSpaceId: "review", language: "en",
  uiPrefs: { ...useStore.getState().uiPrefs, autoSaveFiles: false } });
let dock: DockviewApi | undefined;
let sequence = 0;
const unsupported = async () => { throw new Error("Unexpected fixture transaction"); };
const fixture = {
  ready: () => Boolean(dock),
  open: async (params: Record<string, unknown>) => {
    let receipt: unknown;
    await dispatchCliDesktopPaneRequest({ reqId: `fixture-${++sequence}`, action: "pane.open", params }, {
      routeToSpaceOwner: async () => ({ kind: "local" }), claim: async () => true,
      complete: async (_id, result) => { receipt = result; }, openFile: openLocalFilePane,
      openMobile: unsupported, closePanel: unsupported, movePanel: unsupported,
      ownsFilePresentation: () => false, presentFile: unsupported,
      addSpace: () => { throw new Error("Unexpected fixture Space"); },
      waitForSpace: unsupported, removeSpace: () => {}, spaceName: () => "Review",
    });
    return receipt;
  },
  snapshot: () => ({ activeSpaceId: useStore.getState().activeSpaceId,
    panes: dock?.panels.map((pane) => ({ id: pane.id, component: pane.api.component, params: pane.params })),
    active: dock?.activePanel?.id }),
};
Object.assign(window, { __FILE_PANE_FIXTURE__: fixture });
createRoot(document.getElementById("root")!).render(
  <main className="p-6 text-text-primary">
    <h1 className="mb-2 text-xl">Local documents</h1>
    <p className="mb-4 text-sm text-text-secondary">Disposable browser fixture · GUI file viewer · no native app</p>
    <div style={{ height: 650 }}>
      <DockviewReact className="dockview-theme-abyss" components={{ fileviewer: FileViewerPanel, mockup: MockupPanel }}
        onReady={({ api }) => { dock = api; registerDockview("review", api); }} />
    </div>
  </main>,
);
