import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  exactLayoutRevision,
  exactPaneBindingSnapshot,
} from "@/lib/workspace/layout/layoutCloseIdentity";
import {
  markPaneCloseIntent,
  paneCloseIntentStorageKey,
  persistPaneCloseIntent,
  replayPaneCloseIntents,
  type PaneCloseIntentV1,
} from "@/lib/workspace/pane/paneCloseIntent";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";

const originalLocalStorage = localStorage;

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage,
  });
  useStore.setState({ layouts: {} });
});

afterAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: originalLocalStorage,
  });
});

function fixture(): PaneCloseIntentV1 {
  const panelId = "term:old";
  const params = {
    sessionId: "old",
    binding: hmuxStandaloneBinding("old", "workspace"),
  };
  const originalLayout = {
    panels: { [panelId]: { id: panelId, params } },
  };
  const removedLayout = { panels: {} };
  return {
    schemaVersion: 1,
    operationId: "close-1",
    desktopId: "desktop-1",
    panelId,
    expectedLayoutRevision: exactLayoutRevision(originalLayout),
    removedLayoutRevision: exactLayoutRevision(removedLayout),
    expectedBinding: exactPaneBindingSnapshot(params),
    originalLayout,
    removedLayout,
    phase: "prepared",
  };
}

describe("replayPaneCloseIntents", () => {
  it("restores a pane when the crash happened before the Host boundary", () => {
    const intent = fixture();
    useStore.setState({
      layouts: { [intent.desktopId]: intent.removedLayout },
    });
    persistPaneCloseIntent(intent);

    replayPaneCloseIntents();

    expect(useStore.getState().layouts[intent.desktopId]).toEqual(
      intent.originalLayout,
    );
    expect(
      localStorage.getItem(
        paneCloseIntentStorageKey(intent.desktopId, intent.panelId),
      ),
    ).toBeNull();
  });

  it("restores a legacy journal after Agent pane params were normalized", () => {
    const base = fixture();
    const agent = {
      id: "agent:legacy-sibling",
      contentComponent: "agent",
      params: { agentId: "legacy-sibling" },
    };
    const originalLayout = {
      panels: {
        ...(base.originalLayout as { panels: Record<string, unknown> }).panels,
        [agent.id]: agent,
      },
    };
    const removedLayout = { panels: { [agent.id]: agent } };
    const intent: PaneCloseIntentV1 = {
      ...base,
      originalLayout,
      removedLayout,
      expectedLayoutRevision: exactLayoutRevision(originalLayout),
      removedLayoutRevision: exactLayoutRevision(removedLayout),
    };
    useStore.setState({
      layouts: {
        [intent.desktopId]: {
          panels: { [agent.id]: { ...agent, params: { agentRef: { agentId: "legacy-sibling" } } } },
        },
      },
    });
    persistPaneCloseIntent(intent);

    replayPaneCloseIntents();

    expect(useStore.getState().layouts[intent.desktopId]).toEqual({
      panels: {
        ...(originalLayout.panels as Record<string, unknown>),
        [agent.id]: { ...agent, params: { agentRef: { agentId: "legacy-sibling" } } },
      },
    });
    expect(
      localStorage.getItem(
        paneCloseIntentStorageKey(intent.desktopId, intent.panelId),
      ),
    ).toBeNull();
  });

  it("does not restore after departure might have crossed the Host boundary", () => {
    let intent = fixture();
    useStore.setState({
      layouts: { [intent.desktopId]: intent.removedLayout },
    });
    persistPaneCloseIntent(intent);
    intent = markPaneCloseIntent(intent, "departure_started");

    replayPaneCloseIntents();

    expect(useStore.getState().layouts[intent.desktopId]).toEqual(
      intent.removedLayout,
    );
  });

  it("removes only the crossed pane from a newer sibling layout", () => {
    let intent = fixture();
    const sibling = {
      id: "term:new-sibling",
      params: {
        sessionId: "sibling",
        binding: hmuxStandaloneBinding("sibling", "workspace"),
      },
    };
    const newer = {
      panels: {
        ...(intent.originalLayout as { panels: Record<string, unknown> })
          .panels,
        [sibling.id]: sibling,
      },
    };
    useStore.setState({ layouts: { [intent.desktopId]: newer } });
    persistPaneCloseIntent(intent);
    intent = markPaneCloseIntent(intent, "departure_started");

    replayPaneCloseIntents();

    expect(useStore.getState().layouts[intent.desktopId]).toEqual({
      panels: { [sibling.id]: sibling },
    });
    expect(
      localStorage.getItem(
        paneCloseIntentStorageKey(intent.desktopId, intent.panelId),
      ),
    ).toBeNull();
  });

  it("never deletes a retargeted replacement pane during replay", () => {
    let intent = fixture();
    const replacement = {
      panels: {
        [intent.panelId]: {
          id: intent.panelId,
          params: {
            sessionId: "new",
            binding: hmuxStandaloneBinding("new", "workspace"),
          },
        },
      },
    };
    useStore.setState({ layouts: { [intent.desktopId]: replacement } });
    persistPaneCloseIntent(intent);
    intent = markPaneCloseIntent(intent, "departure_processed");

    replayPaneCloseIntents();

    expect(useStore.getState().layouts[intent.desktopId]).toEqual(replacement);
  });

  it("refuses oversized or structurally invalid journal authority", () => {
    const intent = fixture();
    const key = paneCloseIntentStorageKey(intent.desktopId, intent.panelId);
    const replacement = {
      panels: {
        [intent.panelId]: {
          params: { sessionId: "replacement" },
        },
      },
    };
    useStore.setState({ layouts: { [intent.desktopId]: replacement } });
    localStorage.setItem(key, "x".repeat(2 * 1024 * 1024 + 1));

    replayPaneCloseIntents();

    expect(useStore.getState().layouts[intent.desktopId]).toEqual(replacement);
    expect(localStorage.getItem(key)).not.toBeNull();
  });
});
