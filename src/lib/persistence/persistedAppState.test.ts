import { describe, expect, it } from "vitest";
import {
  migratePersistedState,
  normalizePersistedState,
  persistedSlice,
} from "@/lib/persistence/persistedAppState";
import { DEFAULT_UI_PREFS } from "@/lib/settings/uiPrefs";
import { DEFAULT_SPACES_VIEW_OPTIONS } from "@/lib/spaces/spacesViewOptions";
import { DEFAULT_TERMINAL_LINE_HEIGHT } from "@/lib/terminal/renderer/terminalFont";

describe("migratePersistedState — v6 Space 저장 모델", () => {
  it("legacy Desktop 저장분을 같은 identity의 canonical Space 저장분으로 옮긴다", () => {
    const persisted = migratePersistedState(
      {
        desktops: [
          { id: "desk-main", name: "Main" },
          {
            id: "desk-popout",
            name: "Popout",
            kind: "popout",
            originDesktopId: "desk-main",
            returnLayout: { orientation: "horizontal" },
          },
        ],
        desktopVisits: { "desk-main": 11, "desk-popout": 22 },
        layouts: { "desk-main": { panels: ["pane-1"] } },
        pinnedPanes: { "desk-main:pane-1": true },
      },
      5,
    );

    expect(persisted.spaces).toEqual([
      { id: "desk-main", name: "Main" },
      {
        id: "desk-popout",
        name: "Popout",
        kind: "popout",
        originSpaceId: "desk-main",
        returnLayout: { orientation: "horizontal" },
      },
    ]);
    expect(persisted.spaceVisits).toEqual({ "desk-main": 11, "desk-popout": 22 });
    expect(persisted.layouts).toEqual({ "desk-main": { panels: ["pane-1"] } });
    expect(persisted.pinnedPanes).toEqual({ "desk-main:pane-1": true });
    expect("desktops" in persisted).toBe(false);
    expect("desktopVisits" in persisted).toBe(false);

    const runtime = normalizePersistedState(persisted);
    expect(runtime.spaces[1]).toMatchObject({
      id: "desk-popout",
      originSpaceId: "desk-main",
      returnLayout: { orientation: "horizontal" },
    });
    expect(runtime.layouts).toEqual({ "desk-main": { panels: ["pane-1"] } });
    expect(runtime.pinnedPanes).toEqual({ "desk-main:pane-1": true });
  });

  it("canonical 키가 있으면 mixed legacy 복사본보다 우선한다", () => {
    const runtime = normalizePersistedState({
      spaces: [{ id: "space-canonical", name: "Canonical" }],
      desktops: [{ id: "desk-stale", name: "Stale" }],
      spaceVisits: { "space-canonical": 7 },
      desktopVisits: { "desk-stale": 99 },
    });

    expect(runtime.spaces).toEqual([{ id: "space-canonical", name: "Canonical" }]);
    expect(runtime.spaceVisits).toEqual({ "space-canonical": 7 });
  });

  it("손상된 canonical 키가 있으면 stale legacy authority로 되돌아가지 않는다", () => {
    const runtime = normalizePersistedState({
      spaces: "corrupt",
      desktops: [{ id: "desk-stale", name: "Stale" }],
    });

    expect(runtime.spaces).toHaveLength(1);
    expect(runtime.spaces[0].id).not.toBe("desk-stale");
  });

  it("writer는 canonical Space runtime state에서 legacy 키를 다시 내보내지 않는다", () => {
    const runtime = normalizePersistedState({
      desktops: [{ id: "desk-main", name: "Main" }],
      desktopVisits: { "desk-main": 3 },
    });
    const persisted = persistedSlice(runtime);

    expect(persisted.spaces).toEqual([{ id: "desk-main", name: "Main" }]);
    expect(persisted.spaceVisits).toEqual({ "desk-main": 3 });
    expect("desktops" in persisted).toBe(false);
    expect("desktopVisits" in persisted).toBe(false);

    const repeated = persistedSlice(runtime);
    expect(repeated.spaces).toBe(persisted.spaces);
    expect(repeated.spaceVisits).toBe(persisted.spaceVisits);
  });
});

describe("legacy provider permission authority migration", () => {
  it("retains localStorage input until receipt and omits it after projection", () => {
    const hydrated = normalizePersistedState({
      skipPermissions: { codex: true, claude: false, untrusted: true },
    });
    expect(hydrated.legacySkipPermissions).toEqual({
      codex: true,
      claude: false,
    });
    expect(persistedSlice(hydrated).skipPermissions).toEqual({
      codex: true,
      claude: false,
    });

    const confirmed = persistedSlice({
      ...hydrated,
      skipPermissions: { codex: false },
      legacySkipPermissions: undefined,
    });
    expect("skipPermissions" in confirmed).toBe(false);
  });

  it("does not recreate legacy authority after a restart", () => {
    const restarted = normalizePersistedState(
      persistedSlice(normalizePersistedState({})),
    );
    expect(restarted.legacySkipPermissions).toBeUndefined();
    expect(restarted.skipPermissions).toEqual({});
  });
});

describe("migratePersistedState — v8 인터페이스 모드", () => {
  it("does not synthesize a new Pro preference for pre-v8 state", () => {
    const state = migratePersistedState({ uiPrefs: { tabOrder: "manual" } }, 7);
    expect(state.uiPrefs.interfaceMode).toBe("basic");
  });

  it("does not synthesize Pro along the v1 upgrade path", () => {
    expect(migratePersistedState({}, 1).uiPrefs.interfaceMode).toBe("basic");
  });

  it("preserves an already stored Basic preference", () => {
    expect(
      migratePersistedState({ uiPrefs: { interfaceMode: "basic" } }, 7).uiPrefs
        .interfaceMode,
    ).toBe("basic");
  });

  it("preserves stored Pro despite its ambiguous origin on later reopening", () => {
    expect(
      migratePersistedState({ uiPrefs: { interfaceMode: "pro" } }, 7).uiPrefs
        .interfaceMode,
    ).toBe("pro");
  });

  it("이미 v8이면 그대로 둔다 — 신규 기본 basic이 유지된다", () => {
    expect(
      migratePersistedState({ uiPrefs: {} }, 8).uiPrefs.interfaceMode,
    ).toBe("basic");
  });
});

describe("migratePersistedState — v4 탭 순서", () => {
  it("저장된 'recent'를 manual로 내린다", () => {
    // 리뷰 지적: 기본값만 바꾸면 uiPrefs를 통째로 저장하는 기존 설치에는
    // 도달하지 않아, 배선과 동시에 모든 사용자의 탭이 재정렬된다.
    const state = migratePersistedState({ uiPrefs: { tabOrder: "recent" } }, 3);
    expect(state.uiPrefs.tabOrder).toBe("manual");
  });

  it("v1(구버전)에서 올라오는 경로에서도 내린다", () => {
    const state = migratePersistedState({ uiPrefs: { tabOrder: "recent" } }, 1);
    expect(state.uiPrefs.tabOrder).toBe("manual");
  });

  it("명시적으로 manual을 저장해 둔 값은 건드리지 않는다", () => {
    expect(migratePersistedState({ uiPrefs: { tabOrder: "manual" } }, 3).uiPrefs.tabOrder)
      .toBe("manual");
  });

  it("이미 v4면 그대로 둔다 — 사용자가 고른 recent를 되돌리지 않는다", () => {
    expect(migratePersistedState({ uiPrefs: { tabOrder: "recent" } }, 4).uiPrefs.tabOrder)
      .toBe("recent");
  });

  it("uiPrefs가 없어도 깨지지 않는다", () => {
    expect(migratePersistedState({}, 3).uiPrefs.tabOrder).toBe("manual");
  });

  it("다른 uiPrefs 값은 보존한다", () => {
    const state = migratePersistedState(
      { uiPrefs: { tabOrder: "recent", terminalFontFamily: "Menlo", minimap: false } },
      3,
    );
    expect(state.uiPrefs.terminalFontFamily).toBe("Menlo");
    expect(state.uiPrefs.minimap).toBe(false);
  });
});

describe("normalizePersistedState — 새 영속 필드", () => {
	it("drops duplicated runtime authority from every persisted Agent pane", () => {
		const managedBinding = {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			sessionId: "session-current",
			workspaceId: "workspace-current",
			backendProfileId: "local",
			createIdempotencyKey: "create-current",
			stopFence: {
				runnerPrincipal: "runner-principal",
				runnerInstance: "runner-instance",
				channelEpoch: "1",
				hostInstanceId: "host-instance",
				terminalEpoch: "terminal-epoch",
			},
		};
		const panels: Record<
			string,
			{ contentComponent: string; params: Record<string, unknown> }
		> = Object.fromEntries(
			Array.from({ length: 32 }, (_, index) => {
				const agentId = `agent-${index}`;
				return [
					`agent:${agentId}`,
					{
						contentComponent: "agent",
						params: {
							agentId,
							binding:
								index % 2 === 0
									? managedBinding
									: {
										...managedBinding,
										source: "ssh",
										hostId: "build-host",
										commandBridgeNonce: "bridge-nonce",
									},
							sessionId: `legacy-${index}`,
							backendProfileId: "stale-profile",
						},
					},
				] as const;
			}),
		);
		panels["term:ordinary"] = {
			contentComponent: "terminal",
			params: { binding: managedBinding },
		};
		panels["agent:canonical"] = {
			contentComponent: "agent",
			params: { agentId: "stale-owner", binding: managedBinding },
		};

		const state = normalizePersistedState({
			layouts: { main: { panels } },
		});
		const normalized = state.layouts.main as {
			panels: Record<string, { params: Record<string, unknown> }>;
		};

		for (let index = 0; index < 32; index += 1) {
			expect(normalized.panels[`agent:agent-${index}`]?.params).toEqual({
				agentRef: { agentId: `agent-${index}` },
			});
		}
		expect(normalized.panels["term:ordinary"]?.params.binding).toEqual(
			managedBinding,
		);
		expect(normalized.panels["agent:canonical"]?.params).toEqual({
			agentRef: { agentId: "canonical" },
		});
	});

  it("repairs a pane written with addPanel's `component` key into Dockview's serialized shape", () => {
    const written = {
      id: "term:remote",
      component: "terminal",
      title: "remote",
      params: { sessionId: "standalone_x" },
    };
    const repaired = {
      id: "term:remote",
      contentComponent: "terminal",
      title: "remote",
      params: { sessionId: "standalone_x" },
    };

    const hydrated = normalizePersistedState({
      layouts: { main: { panels: { "term:remote": written } } },
    });
    expect(hydrated.layouts.main).toEqual({
      panels: { "term:remote": repaired },
    });

    const persisted = persistedSlice({
      ...hydrated,
      layouts: { main: { panels: { "term:remote": written } } },
    });
    expect(persisted.layouts.main).toEqual({
      panels: { "term:remote": repaired },
    });
  });

  it("normalizes terminal line height at the persistence boundary", () => {
    expect(
      normalizePersistedState({ uiPrefs: { terminalLineHeight: 1.43 } })
        .uiPrefs.terminalLineHeight,
    ).toBe(1.45);
    expect(
      normalizePersistedState({ uiPrefs: { terminalLineHeight: "broken" } })
        .uiPrefs.terminalLineHeight,
    ).toBe(DEFAULT_TERMINAL_LINE_HEIGHT);
  });

  it("discards the retired opacity slider while preserving pane spacing", () => {
    const state = normalizePersistedState({
      uiPrefs: { surfaceOpacity: 30, splitterSize: 7 },
    });
    expect(state.uiPrefs).not.toHaveProperty("surfaceOpacity");
    expect(state.uiPrefs.splitterSize).toBe(7);
  });

  it("keeps only active terminal preferences at the persistence boundary", () => {
    expect(
      normalizePersistedState({
        terminalPrefs: {
          copyOnSelect: false,
          osc52: "invalid",
          gpu: "on",
          scrollbackLines: 50_000,
        },
      }).terminalPrefs,
    ).toEqual({ copyOnSelect: false, osc52: true });
  });

	it("migrates the former Spaces grouping preference into view options", () => {
		const legacySpaceFirst = normalizePersistedState({
			uiPrefs: { spacesGroupBy: "space" },
		});
		expect(legacySpaceFirst.uiPrefs.spacesViewOptions).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "space",
		});
		expect("spacesGroupBy" in legacySpaceFirst.uiPrefs).toBe(false);

		expect(
			normalizePersistedState({
				uiPrefs: { spacesViewOptions: { groupBy: "machine" } },
			}).uiPrefs.spacesViewOptions,
		).toEqual(DEFAULT_SPACES_VIEW_OPTIONS);
		expect(
			normalizePersistedState({
				uiPrefs: {
					spacesViewOptions: { groupBy: "space", orderBy: "status" },
				},
			}).uiPrefs.spacesViewOptions,
		).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "space",
			orderBy: "status",
		});
		expect(
			normalizePersistedState({
				uiPrefs: {
					spacesViewOptions: { groupBy: "updated", orderBy: "status" },
				},
			}).uiPrefs.spacesViewOptions,
		).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "updated",
			orderBy: "status",
		});
		expect(
			normalizePersistedState({
				uiPrefs: {
					spacesViewOptions: { groupBy: "location", orderBy: "status" },
				},
			}).uiPrefs.spacesViewOptions,
		).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "location",
			orderBy: "status",
		});
		expect(
			normalizePersistedState({
				uiPrefs: {
					spacesViewOptions: { groupBy: "environment", orderBy: "status" },
				},
			}).uiPrefs.spacesViewOptions,
		).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "environment",
			orderBy: "status",
		});
	});

	it("normalizes Sessions view options at the persistence boundary", () => {
		expect(
			normalizePersistedState({
				uiPrefs: {
					sessionsViewOptions: {
						groupBy: "provider",
						orderBy: "oldest",
						paneFilter: "open_only",
					},
				},
			}).uiPrefs.sessionsViewOptions,
		).toEqual({
			groupBy: "provider",
			orderBy: "oldest",
			paneFilter: "open_only",
		});
		expect(
			normalizePersistedState({
				uiPrefs: {
					sessionsViewOptions: {
						groupBy: "machine",
						orderBy: "oldest",
						paneFilter: "everything",
					},
				},
			}).uiPrefs.sessionsViewOptions,
		).toEqual({
			groupBy: "repository",
			orderBy: "oldest",
			paneFilter: "all",
		});
	});

  it("깨진 저장분을 걸러낸다", () => {
    const state = normalizePersistedState({
      desktopVisits: { a: 1, bad: "x", nan: Number.NaN },
      pinnedPanes: { "desk:a": true, "desk:b": false, "desk:c": "yes" },
      shortcutOverrides: {
        good: { mod: true, shift: false, alt: false, key: "k" },
        cleared: null,
        bad: { mod: "yes" },
        empty: { mod: true, shift: false, alt: false, key: "" },
      },
    });
    expect(state.spaceVisits).toEqual({ a: 1 });
    expect(state.pinnedPanes).toEqual({ "desk:a": true });
    expect(Object.keys(state.shortcutOverrides).sort()).toEqual(["cleared", "good"]);
    // null은 "일부러 비운 할당"이라 유효한 값이다.
    expect(state.shortcutOverrides.cleared).toBeNull();
  });

  it("필드가 통째로 없거나 배열이어도 빈 객체로 시작한다", () => {
    const state = normalizePersistedState({ desktopVisits: [], pinnedPanes: null });
    expect(state.spaceVisits).toEqual({});
    expect(state.pinnedPanes).toEqual({});
    expect(state.shortcutOverrides).toEqual({});
  });

  it("구버전 빈 알림음은 시스템 기본음으로 정규화하고 명시적 무음은 보존한다", () => {
    expect(normalizePersistedState({ notifyPrefs: { sound: "" } }).notifyPrefs.sound)
      .toBe("__system__");
    expect(normalizePersistedState({ notifyPrefs: { sound: "__none__" } }).notifyPrefs.sound)
      .toBe("__none__");
    expect(normalizePersistedState({ notifyPrefs: { sound: 42 } }).notifyPrefs.sound)
      .toBe("__system__");
  });

  it("pre-rename built-in theme ids를 읽은 즉시 canonical state로 바꾼다", () => {
    const state = normalizePersistedState({
      uiPrefs: {
        themeScheme: { dark: "hebbian-dark", light: "hebbian-light" },
      },
    });

    expect(state.uiPrefs.themeScheme).toEqual({
      dark: "dure-dark",
      light: "dure-light",
    });
    expect(JSON.stringify(persistedSlice(state))).not.toContain("hebbian-");
  });
});

describe("migratePersistedState — v5 배선된 기본값", () => {
  // (비활성 창 불투명도 마이그레이션은 흐리기 기능 제거와 함께 걷혔다 —
  // 저장에 남은 키는 읽는 곳이 없다.)

  it("자동 저장은 꺼진다 — 사용자 몰래 디스크에 쓰지 않는다", () => {
    expect(migratePersistedState({ uiPrefs: { autoSaveFiles: true } }, 4).uiPrefs.autoSaveFiles)
      .toBe(false);
  });

  it("diff 줄바꿈은 켜진다 — 배선 전 동작이 무조건 줄바꿈이었다", () => {
    expect(migratePersistedState({ uiPrefs: { diffWordWrap: false } }, 4).uiPrefs.diffWordWrap)
      .toBe(true);
  });

  it("일부러 바꿔 둔 값은 건드리지 않는다", () => {
    const state = migratePersistedState(
      { uiPrefs: { autoSaveFiles: false, diffWordWrap: true } },
      4,
    );
    expect(state.uiPrefs.autoSaveFiles).toBe(false);
    expect(state.uiPrefs.diffWordWrap).toBe(true);
  });

  it("이미 v5면 그대로 둔다", () => {
    expect(migratePersistedState({ uiPrefs: { autoSaveFiles: true } }, 5).uiPrefs.autoSaveFiles)
      .toBe(true);
  });

  it("v3에서 올라와도 v4·v5 마이그레이션이 함께 걸린다", () => {
    const state = migratePersistedState(
      { uiPrefs: { tabOrder: "recent", autoSaveFiles: true } },
      3,
    );
    expect(state.uiPrefs.tabOrder).toBe("manual");
    expect(state.uiPrefs.autoSaveFiles).toBe(false);
  });
});

describe("migratePersistedState — v9 pane 간격", () => {
  it("migrates the retired 6px default to the current default", () => {
    expect(
      migratePersistedState({ uiPrefs: { splitterSize: 6 } }, 8).uiPrefs
        .splitterSize,
    ).toBe(DEFAULT_UI_PREFS.splitterSize);
  });

  it("v1(구버전)에서 올라오는 경로에서도 내린다", () => {
    expect(
      migratePersistedState({ uiPrefs: { splitterSize: 6 } }, 1).uiPrefs
        .splitterSize,
    ).toBe(DEFAULT_UI_PREFS.splitterSize);
  });

  it("6이 아닌 명시값(4)은 건드리지 않는다", () => {
    expect(
      migratePersistedState({ uiPrefs: { splitterSize: 4 } }, 8).uiPrefs
        .splitterSize,
    ).toBe(4);
  });

  it("이미 v9면 저장된 6을 그대로 둔다", () => {
    expect(
      migratePersistedState({ uiPrefs: { splitterSize: 6 } }, 9).uiPrefs
        .splitterSize,
    ).toBe(6);
  });
});

describe("migratePersistedState — pane divider default", () => {
  it("moves the previous default once and preserves subsequent choices", () => {
    expect(migratePersistedState({ uiPrefs: { splitterSize: 2 } }, 9).uiPrefs.splitterSize)
      .toBe(DEFAULT_UI_PREFS.splitterSize);
    expect(migratePersistedState({ uiPrefs: { splitterSize: 7 } }, 9).uiPrefs.splitterSize)
      .toBe(7);
    expect(migratePersistedState({ uiPrefs: { splitterSize: 2 } }, 10).uiPrefs.splitterSize)
      .toBe(2);
  });
});
