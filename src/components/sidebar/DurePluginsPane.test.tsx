// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshPluginViewCatalog,
  resetPluginViewCatalogForTests,
  usePluginViewCatalog,
} from "@/components/plugins/usePluginViewCatalog";
import type {
  DurePluginCatalogEntry,
  DurePluginCatalogOutcomeV2,
  DurePluginCatalogSnapshotV2,
  DurePluginSettingsSnapshot,
} from "@/lib/plugins/durePlugins";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/ipc", () => {
  return {
    durePluginCatalogV2: mocks.list,
    durePluginSettingsGet: mocks.get,
    durePluginSettingsUpdate: mocks.update,
  };
});

import { DurePluginsPane } from "@/components/sidebar/DurePluginsPane";
import { useStore } from "@/store";

const entry: DurePluginCatalogEntry = {
  manifest: {
    schema_version: 2,
    id: "dure.beads",
    publisher: "dure",
    version: "0.2.0",
    display_name: "Beads",
    description:
      "Beads 패키지에는 Codex와 Claude Code 연동 플러그인이 함께 포함되어 있습니다.",
    host_api: { min_inclusive: 1, max_inclusive: 2 },
    agent_integrations: [
      {
        id: "dure.beads.codex",
        adapter: "codex",
        required: false,
        resource: "./agents/codex",
        selector: { plugin: "dure-beads", marketplace: "dure-bundled" },
      },
      {
        id: "dure.beads.claude",
        adapter: "claude",
        required: false,
        resource: "./agents/claude",
        selector: { plugin: "dure-beads", marketplace: "dure-bundled" },
      },
    ],
  },
  compatibility: {
    status: "supported",
    negotiated_host_api_version: 2,
    contributions: [],
    ignored_optional_contributions: [],
    enabled_agent_integrations: ["dure.beads.codex", "dure.beads.claude"],
    ignored_optional_agent_integrations: [],
  },
  distribution: "bundled",
  installed: true,
  removable: false,
  settings_contribution: {
    target: {
      identity: {
        source_id: "dure.bundled",
        candidate_id: "dure.beads.bundled",
      },
      plugin_id: "dure.beads",
      version: "0.2.0",
      contribution_id: "dure.beads.settings",
    },
    contribution_id: "dure.beads.settings",
    schema: {
      schema_version: 1,
      settings: [
        {
          kind: "boolean",
          key: "notifications",
          title: "Beads 알림",
          description: "알림 설명",
          scope: "user",
          default: true,
        },
      ],
    },
  },
  issue_tracker_contributions: [],
  view_contributions: [],
};

const available: DurePluginCatalogOutcomeV2 = {
  status: "available",
  identity: {
    source_id: "dure.bundled",
    candidate_id: "dure.beads.bundled",
  },
  entry,
};

function snapshot(
  outcomes: DurePluginCatalogOutcomeV2[] = [available],
): DurePluginCatalogSnapshotV2 {
  return { schema_version: 2, outcomes };
}

const userSettings: DurePluginSettingsSnapshot = {
  target: entry.settings_contribution!.target,
  scope: "user",
  scope_key: null,
  values: { notifications: true },
};

afterEach(() => {
  cleanup();
  resetPluginViewCatalogForTests();
  vi.resetAllMocks();
});

function CatalogProbe() {
  const state = usePluginViewCatalog();
  return <div>catalog consumers: {state.snapshot?.outcomes.length ?? "loading"}</div>;
}

describe("DurePluginsPane", () => {
  it("keeps Slack available and preserves its selected detail in Basic and Pro", async () => {
    const original = useStore.getState().uiPrefs;
    const slack: DurePluginCatalogOutcomeV2 = {
      ...available,
      identity: { source_id: "dure.bundled", candidate_id: "dure.slack.bundled" },
      entry: { ...entry, manifest: { ...entry.manifest, id: "dure.slack", display_name: "Slack" }, settings_contribution: null },
    };
    mocks.list.mockResolvedValue(snapshot([available, slack]));
    try {
      useStore.setState({ uiPrefs: { ...original, interfaceMode: "basic" } });
      render(<DurePluginsPane />);
      await screen.findAllByText("Beads");
      expect(screen.getByText("Slack")).toBeTruthy();
      act(() => useStore.setState({ uiPrefs: { ...original, interfaceMode: "pro" } }));
      fireEvent.click(await screen.findByText("Slack"));
      expect(screen.getAllByText("Slack")).toHaveLength(2);
      act(() => useStore.setState({ uiPrefs: { ...original, interfaceMode: "basic" } }));
      expect(screen.getAllByText("Slack")).toHaveLength(2);
    } finally {
      act(() => useStore.setState({ uiPrefs: original }));
    }
  });
  it("keeps the Slack plugin available in production Beta", async () => {
    const original = useStore.getState().uiPrefs;
    const slack: DurePluginCatalogOutcomeV2 = {
      ...available,
      identity: { source_id: "dure.bundled", candidate_id: "dure.slack.bundled" },
      entry: { ...entry, manifest: { ...entry.manifest, id: "dure.slack", display_name: "Slack" }, settings_contribution: null },
    };
    mocks.list.mockResolvedValue(snapshot([available, slack]));
    vi.stubEnv("PROD", true);
    try {
      useStore.setState({ uiPrefs: { ...original, interfaceMode: "pro" } });
      render(<DurePluginsPane />);
      await screen.findAllByText("Beads");
      expect(screen.getByText("Slack")).toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
      act(() => useStore.setState({ uiPrefs: original }));
    }
  });

  it("shows Beads as a bundled Dure plugin with Codex and Claude integrations", async () => {
    mocks.list.mockResolvedValue(snapshot());
    mocks.get.mockResolvedValue(userSettings);

    render(<DurePluginsPane />);

    expect(await screen.findAllByText("Beads")).toHaveLength(2);
    expect(screen.getByText(/내장/)).toBeTruthy();
    expect(
      screen.getAllByText(
        "Beads 패키지에는 Codex와 Claude Code 연동 플러그인이 함께 포함되어 있습니다.",
      ),
    ).toHaveLength(2);
    expect(screen.getByText(/Codex · Claude Code/)).toBeTruthy();
    expect(screen.getByText("현재 Dure 버전과 호환됨")).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("draws each plugin's own mark, the package cube only without one", async () => {
    const beads: DurePluginCatalogOutcomeV2 = {
      ...available,
      entry: {
        ...entry,
        view_contributions: [
          {
            contribution_id: "dure.beads.views",
            views: {
              schema_version: 1,
              containers: [
                {
                  id: "dure.beads.issues",
                  location: "primary_sidebar",
                  title: { default: "Beads" },
                  icon: "list_todo",
                },
              ],
              views: [],
            },
          },
        ],
      },
    };
    const github: DurePluginCatalogOutcomeV2 = {
      status: "available",
      identity: { source_id: "dure.bundled", candidate_id: "dure.github.bundled" },
      entry: {
        ...entry,
        manifest: { ...entry.manifest, id: "dure.github", display_name: "GitHub" },
        settings_contribution: null,
        view_contributions: [
          {
            contribution_id: "dure.github.views",
            views: {
              schema_version: 1,
              containers: [
                {
                  id: "dure.github.work",
                  location: "primary_sidebar",
                  title: { default: "GitHub" },
                  icon: "github",
                },
              ],
              views: [],
            },
          },
        ],
      },
    };
    const core: DurePluginCatalogOutcomeV2 = {
      status: "available",
      identity: { source_id: "dure.bundled", candidate_id: "dure.core.bundled" },
      entry: {
        ...entry,
        manifest: { ...entry.manifest, id: "dure.core", display_name: "Dure Core" },
        settings_contribution: null,
        view_contributions: [],
      },
    };
    mocks.list.mockResolvedValue(snapshot([beads, github, core]));
    mocks.get.mockResolvedValue(userSettings);

    render(<DurePluginsPane />);

    const rowOf = (name: string) =>
      screen.getAllByText(name)[0]?.closest("button") as HTMLElement;
    await screen.findByText("Dure Core");
    expect(
      rowOf("GitHub").querySelector("svg path")?.getAttribute("d"),
    ).toMatch(/^M15 22v-4/);
    expect(rowOf("Beads").querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-list-todo",
    );
    expect(rowOf("Dure Core").querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-box",
    );
  });

  it("shares one catalog request with other plugin surfaces", async () => {
    mocks.list.mockResolvedValue(snapshot());

    render(
      <>
        <DurePluginsPane />
        <CatalogProbe />
      </>,
    );

    expect(await screen.findByText("catalog consumers: 1")).toBeTruthy();
    expect(await screen.findAllByText("Beads")).toHaveLength(2);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("publishes a pane refresh to every catalog consumer", async () => {
    mocks.list
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot([]));

    render(
      <>
        <DurePluginsPane />
        <CatalogProbe />
      </>,
    );
    expect(await screen.findByText("catalog consumers: 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));

    expect(await screen.findByText("catalog consumers: 0")).toBeTruthy();
    expect(await screen.findByText("결과 없음")).toBeTruthy();
    expect(screen.queryByText("Beads")).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a selection that disappeared from the catalog", async () => {
    const broken: DurePluginCatalogOutcomeV2 = {
      status: "rejected",
      identity: { source_id: "dure.installed", candidate_id: "broken" },
      manifest: {
        ...entry.manifest,
        id: "example.broken",
        display_name: "Broken package",
      },
      reason: { kind: "source_rejected" },
    };
    mocks.list
      .mockResolvedValueOnce(snapshot([available, broken]))
      .mockResolvedValueOnce(snapshot([available]))
      .mockResolvedValueOnce(snapshot([broken, available]));

    render(<DurePluginsPane />);
    fireEvent.click(await screen.findByText("Broken package"));
    expect(
      screen.getByText("example.broken · dure.installed · broken"),
    ).toBeTruthy();

    await act(async () => {
      await refreshPluginViewCatalog();
    });
    expect(
      screen.getByRole("button", { name: "Beads · 플러그인 설정" }),
    ).toBeTruthy();

    await act(async () => {
      await refreshPluginViewCatalog();
    });
    expect(
      screen.getByRole("button", { name: "Beads · 플러그인 설정" }),
    ).toBeTruthy();
    expect(
      screen.queryByText("example.broken · dure.installed · broken"),
    ).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it("recovers the shared catalog after a transient load failure", async () => {
    mocks.list
      .mockRejectedValueOnce(new Error("catalog offline"))
      .mockResolvedValueOnce(snapshot());

    render(<DurePluginsPane />);

    expect(await screen.findByText("Error: catalog offline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));

    expect(await screen.findAllByText("Beads")).toHaveLength(2);
    expect(screen.queryByText("Error: catalog offline")).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("opens scoped settings separately and persists through the Dure command", async () => {
    mocks.list.mockResolvedValue(snapshot());
    mocks.get.mockResolvedValue(userSettings);
    mocks.update.mockImplementation(
      async (snapshot: DurePluginSettingsSnapshot) => snapshot,
    );

    render(<DurePluginsPane />);
    await screen.findAllByText("Beads");
    expect(screen.queryByRole("switch", { name: "Beads 알림" })).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Beads · 플러그인 설정" }),
    );

    const toggle = await screen.findByRole("switch", { name: "Beads 알림" });
    await waitFor(() => expect(toggle.getAttribute("data-state")).toBe("checked"));
    expect(
      screen.getByRole("dialog", { name: "Beads · 플러그인 설정" }),
    ).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledWith(
      entry.settings_contribution!.target,
      "user",
    );
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        ...userSettings,
        values: { notifications: false },
      }),
    );
  });

  it("opens and persists settings for a non-Beads catalog package", async () => {
    const preferences: DurePluginCatalogEntry = {
      ...entry,
      manifest: {
        ...entry.manifest,
        id: "example.preferences",
        publisher: "example",
        display_name: "Example preferences",
        description: "Example package settings",
        agent_integrations: [],
      },
      settings_contribution: {
        target: {
          identity: {
            source_id: "dure.bundled",
            candidate_id: "example.preferences.bundled",
          },
          plugin_id: "example.preferences",
          version: "0.2.0",
          contribution_id: "example.preferences.settings",
        },
        contribution_id: "example.preferences.settings",
        schema: {
          schema_version: 1,
          settings: [
            {
              kind: "boolean",
              key: "compact_mode",
              title: "간결 모드",
              description: "간결한 표시를 사용합니다.",
              scope: "user",
              default: false,
            },
          ],
        },
      },
    };
    const settings: DurePluginSettingsSnapshot = {
      target: preferences.settings_contribution!.target,
      scope: "user",
      scope_key: null,
      values: { compact_mode: false },
    };
    mocks.list.mockResolvedValue(
      snapshot([
        {
          status: "available",
          identity: {
            source_id: "dure.bundled",
            candidate_id: "example.preferences.bundled",
          },
          entry: preferences,
        },
      ]),
    );
    mocks.get.mockResolvedValue(settings);
    mocks.update.mockImplementation(
      async (next: DurePluginSettingsSnapshot) => next,
    );

    render(<DurePluginsPane />);
    await screen.findAllByText("Example preferences");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Example preferences · 플러그인 설정",
      }),
    );

    const toggle = await screen.findByRole("switch", { name: "간결 모드" });
    expect(mocks.get).toHaveBeenCalledWith(
      preferences.settings_contribution!.target,
      "user",
    );
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        ...settings,
        values: { compact_mode: true },
      }),
    );
  });

  it("does not retarget an open settings dialog after the package contract changes", async () => {
    const nextEntry: DurePluginCatalogEntry = {
      ...entry,
      manifest: { ...entry.manifest, version: "0.3.0" },
      settings_contribution: {
        ...entry.settings_contribution!,
        target: {
          ...entry.settings_contribution!.target,
          identity: {
            source_id: "dure.bundled",
            candidate_id: "dure.beads.next",
          },
          version: "0.3.0",
        },
      },
    };
    mocks.list
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(
        snapshot([
          {
            ...available,
            identity: {
              source_id: "dure.bundled",
              candidate_id: "dure.beads.next",
            },
            entry: nextEntry,
          },
        ]),
      );
    mocks.get.mockResolvedValue(userSettings);

    render(<DurePluginsPane />);
    await screen.findAllByText("Beads");
    fireEvent.click(
      screen.getByRole("button", { name: "Beads · 플러그인 설정" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Beads · 플러그인 설정" }),
    ).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await refreshPluginViewCatalog();
    });

    expect(await screen.findByText(/v0\.3\.0/)).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Beads · 플러그인 설정" }),
      ).toBeNull(),
    );
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("shows permission-only plugin settings without inventing schema IPC", async () => {
    const agentOnly: DurePluginCatalogEntry = {
      ...entry,
      manifest: {
        ...entry.manifest,
        id: "example.agent-only",
        publisher: "example",
        display_name: "Agent only",
        description: undefined,
      },
      settings_contribution: null,
    };
    mocks.list.mockResolvedValue(
      snapshot([
        {
          status: "available",
          identity: { source_id: "dure.bundled", candidate_id: "agent-only" },
          entry: agentOnly,
        },
      ]),
    );

    render(<DurePluginsPane />);

    expect(await screen.findAllByText("Agent only")).toHaveLength(2);
    expect(screen.getByText(/Codex/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Agent only · 플러그인 설정" }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "Agent only · 플러그인 설정",
      }),
    ).toBeTruthy();
    expect(screen.getByText("이 플러그인에는 추가 설정이 없습니다.")).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("keeps Beads visible beside rejected and conflicting packages", async () => {
    mocks.list.mockResolvedValue(
      snapshot([
        available,
        {
          status: "rejected",
          identity: { source_id: "dure.installed", candidate_id: "broken" },
          manifest: {
            ...entry.manifest,
            id: "example.broken",
            publisher: "example",
            display_name: "Broken package",
          },
          reason: {
            kind: "invalid_contribution",
            contribution_id: "example.broken.views",
            family: "dure.views",
          },
        },
        {
          status: "conflict",
          plugin_id: "example.duplicate",
          candidates: [
            {
              source_id: "dure.installed",
              candidate_id: "first",
              version: "1.0.0",
            },
            {
              source_id: "dure.installed",
              candidate_id: "second",
              version: "2.0.0",
            },
          ],
        },
      ]),
    );

    render(<DurePluginsPane />);

    expect(await screen.findAllByText("Beads")).toHaveLength(2);
    expect(screen.getByText("Broken package")).toBeTruthy();
    expect(screen.getByText("example.duplicate")).toBeTruthy();
    expect(screen.getByText(/사용 불가/)).toBeTruthy();
    expect(screen.getByText(/충돌/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Beads · 플러그인 설정" }),
    ).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Broken package"));
    expect(
      screen.getByText("example.broken · dure.installed · broken"),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("example.duplicate"));
    expect(screen.getByText("dure.installed · first · v1.0.0")).toBeTruthy();
    expect(screen.getByText("dure.installed · second · v2.0.0")).toBeTruthy();
  });
});
