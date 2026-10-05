import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { createDockview, type DockviewApi } from "dockview-react";
import { PaneActionDropdown } from "@/components/workspace/PaneActionMenu";
import { buildPaneActionMenuSections } from "@/components/workspace/PaneActionMenuSections";
import { dispatchCliDesktopPaneRequest } from "@/lib/cli/cliDesktopPaneLifecycle";
import { movePaneToSpace } from "@/lib/workspace/dock";
import { registerDockview } from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import "dockview-react/dist/styles/dockview.css";
import "@/index.css";

// Real menu, Store, CLI dispatcher and Dockview; disposable content, no PTYs.
const spaces = [{ id: "source", name: "Workspace" }, { id: "target", name: "Review" }];
useStore.setState({ spaces, activeSpaceId: "source", layouts: {}, language: "en" });
const docks = new Map<string, DockviewApi>();
const noop = () => {};
const sections = buildPaneActionMenuSections({
  agent: undefined, basicInterface: true, closePane: noop, conversionBusy: false,
  conversionTarget: undefined, convertSession: noop, copyIdentifier: noop,
  delegateTask: undefined, desktopId: "source", desktopKind: undefined, spaces,
  hide: undefined, history: undefined, hostId: undefined, newAgent: noop,
  openAgentRename: undefined, openPaneInfo: noop, openPaneRename: noop,
  panelId: "moving", file: undefined, pinned: false, rehostAvailable: false,
  rehostBusy: false, recentSshHostId: undefined, rehostToCurrentBuild: noop,
  removableWorktree: false, splitPane: noop, splitSshPane: noop,
  splitTerminalPane: noop, sshHosts: [], switchCandidates: [], switchToAgent: noop,
  togglePin: noop, deleteAgent: noop,
});

function Fixture() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    for (const space of spaces) {
      const container = document.getElementById(`dock-${space.id}`)!;
      const api = createDockview(container, { createComponent: () => {
        const element = document.createElement("textarea");
        element.className = "size-full resize-none bg-surface-pane p-6 text-sm text-text-primary";
        return { element, init(options) { element.setAttribute("aria-label", options.params.fixtureLabel); element.value = `Working draft: ${options.params.fixtureLabel}`; } };
      } });
      docks.set(space.id, api);
      registerDockview(space.id, api);
      api.layout(container.clientWidth, 390);
      const ids = space.id === "source" ? ["moving", "source-stay"] : ["target-stay"];
      for (const id of ids) api.addPanel({ id, component: "fixture", title: id, params: { sessionId: `session-${id}`, fixtureLabel: id }, position: { direction: "right" } });
    }
  }, []);
  return <main className="p-8 text-text-primary">
    <h1 className="mb-2 text-xl">Space and pane controls</h1>
    <p className="mb-6 text-sm text-text-secondary">Disposable browser fixture · running session identities are represented by fixture data.</p>
    <PaneActionDropdown open={open} onOpenChange={setOpen} sections={sections} trigger={<button type="button" className="mb-4 rounded border px-4 py-2">Pane menu</button>} />
    <div className="grid grid-cols-2 gap-6">{spaces.map((space) => <section key={space.id}><h2 className="mb-3">{space.name}</h2><div id={`dock-${space.id}`} className="dockview-theme-abyss" style={{ height: 390 }} /></section>)}</div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

const fixture = {
  snapshot: () => ({ activeSpaceId: useStore.getState().activeSpaceId,
    spaces: useStore.getState().spaces, layouts: useStore.getState().layouts,
    panes: Object.fromEntries([...docks].map(([id, api]) => [id, { active: api.activePanel?.id, ids: api.panels.map((pane) => pane.id), sessions: api.panels.map((pane) => pane.params?.sessionId) }])) }),
  create: async (select: boolean) => {
    let receipt: unknown;
    await dispatchCliDesktopPaneRequest({ reqId: "fixture-create", action: "space.create", params: { name: "Background", select } }, {
      routeToSpaceOwner: async () => ({ kind: "local" }), claim: async () => true,
      complete: async (_id, result) => { receipt = result; }, closePanel: async () => null,
      movePanel: movePaneToSpace, addSpace: (name, activate) => useStore.getState().addSpace({ name, activate }),
      waitForSpace: async () => ({}), removeSpace: (id) => useStore.getState().removeSpace(id),
      spaceName: (id) => useStore.getState().spaces.find((space) => space.id === id)?.name,
      openMobile: async () => ({}),
    });
    return receipt;
  },
  move: movePaneToSpace,
};
Object.assign(window, { __SPACE_PANE_FIXTURE__: fixture });
