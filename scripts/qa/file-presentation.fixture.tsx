import { createRoot, type Root } from "react-dom/client";
import { FilePresentationWindowRoot } from "@/components/files/FilePresentationWindow";
import { dispatchCliDesktopPaneRequest } from "@/lib/cli/cliDesktopPaneLifecycle";
import { presentLocalFile } from "@/lib/files/localFilePresentation";
import { ensureLangLoaded } from "@/lib/i18n";
import { useStore } from "@/store";
import type { Agent } from "@/types";
import "@/index.css";

// Real CLI dispatcher, presenter, window opener, presentation window root and
// file viewer. The browser runner supplies Tauri IPC (windows, events, file
// reads) as a fixture: creating the presentation window mounts its root here,
// closing it unmounts the root.
await ensureLangLoaded("en");
const presenter = {
  id: "agent-qa", name: "qa-worker", displayName: "QA reviewer", provider: "claude", projectId: "qa",
  worktreePath: "/qa", branch: "main", sessionId: "qa-session", sessionKind: "pty",
} as unknown as Agent;
useStore.setState({ language: "en", agents: [presenter],
  uiPrefs: { ...useStore.getState().uiPrefs, autoSaveFiles: false } });
let sequence = 0;
let windowRoot: Root | undefined;
const unsupported = async () => { throw new Error("Unexpected fixture transaction"); };
const fixture = {
  ready: () => true,
  present: async (params: Record<string, unknown>) => {
    let receipt: unknown;
    await dispatchCliDesktopPaneRequest({ reqId: `fixture-${++sequence}`, action: "pane.open", params }, {
      routeToSpaceOwner: unsupported, claim: async () => true,
      complete: async (_id, result) => { receipt = result; },
      ownsFilePresentation: () => true, presentFile: presentLocalFile,
      openFile: unsupported, openMobile: unsupported, closePanel: unsupported, movePanel: unsupported,
      addSpace: () => { throw new Error("Unexpected fixture Space"); },
      waitForSpace: unsupported, removeSpace: () => {}, spaceName: () => undefined,
    });
    return receipt;
  },
  mountWindow: () => {
    windowRoot = createRoot(document.getElementById("root")!);
    windowRoot.render(<FilePresentationWindowRoot />);
  },
  unmountWindow: () => {
    windowRoot?.unmount();
    windowRoot = undefined;
  },
};
Object.assign(window, { __FILE_PRESENTATION_FIXTURE__: fixture });
