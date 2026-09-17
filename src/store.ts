import { create } from "zustand";
import {
  createAgentChatDraftStoreSlice,
  type AgentChatDraftStoreSlice,
} from "@/lib/agents/chat/agentChatDraftStoreSlice";
import { persist } from "zustand/middleware";
import { reorderDesktopItems } from "@/lib/workspace/desktop/desktopOrder";
import { recordDesktopVisit } from "@/lib/workspace/desktop/desktopTabOrder";
import { dropPinnedPanesForDesktop, togglePinnedPane } from "@/lib/workspace/pane/panePin";
import { capFileTreeRoots } from "@/lib/persistence/storeCollections";
import {
  migratePersistedState,
  normalizePersistedState,
  persistedSlice,
  type PersistedAppState,
} from "@/lib/persistence/persistedAppState";
import { nanoid } from "nanoid";
import type { Space } from "@/types";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";
import { convergePersistedAppState } from "@/lib/persistence/persistedAppStateConvergence";
import { publishDurableStoreChanged } from "@/lib/workspace/window/durableStoreBroadcast";
import {
  DEFAULT_SPACE,
  nextSpaceName,
} from "@/lib/workspace/desktop/desktopNames";
import { withDesktopStateCompatibility } from "@/lib/workspace/desktop/desktopStateCompatibility";
import { normalizePersistedPaneLayout } from "@/lib/workspace/layout/persistedPaneLayout";
import type {
  AddDesktopOptions,
  AddSpaceOptions,
  SpaceDesktopCompatibilitySlice,
} from "@/lib/workspace/desktop/desktopStateCompatibilityTypes";
export type { AddDesktopOptions, AddSpaceOptions };
import {
  createProviderLaunchDefaultsStoreSlice,
  type ProviderLaunchDefaultsStoreSlice,
} from "@/lib/settings/providerLaunchDefaultsStoreSlice";
import {
  createSessionRuntimeStoreSlice,
  type SessionRuntimeStoreSlice,
} from "@/lib/sessions/runtime/sessionRuntimeStoreSlice";
import {
  createScmReviewStoreSlice,
  type ScmReviewStoreSlice,
} from "@/lib/scm/review/scmReviewStoreSlice";
import {
  createSshHostsStoreSlice,
  type SshHostsStoreSlice,
} from "@/lib/ssh/sshHostsStoreSlice";
import {
  createAccountProfilesStoreSlice,
  type AccountProfilesStoreSlice,
} from "@/lib/agents/accountProfilesStoreSlice";
import {
  createAgentRegistryStoreSlice,
  type AgentRegistryStoreSlice,
} from "@/lib/agents/agentRegistryStoreSlice";
import {
  createAppPrefsStoreSlice,
  type AppPrefsStoreSlice,
} from "@/lib/settings/appPrefsStoreSlice";
import {
  createProjectsStoreSlice,
  type ProjectsStoreSlice,
} from "@/lib/spaces/projectsStoreSlice";
import { planProjectRegistration } from "@/lib/spaces/projectAdd";

/** 왼쪽 아이콘 레일에서 고를 수 있는 사이드바 패널. */
export type { SidebarTab } from "@/lib/sidebar/sidebarTabs";

// 외관 설정은 lib/uiPrefs로 추출 — 기존 import 경로 호환을 위해 재노출한다.
import { DEFAULT_UI_PREFS, type UiPrefs } from "@/lib/settings/uiPrefs";
import {
  type FocusContext,
  sameFocusContext,
} from "@/lib/workspace/focusContext";
export { DEFAULT_UI_PREFS, type UiPrefs };

// 알림 설정·누적 통계는 lib/notifyPrefs로 추출 — 기존 import 경로 호환을 위해 재노출.
import {
  DEFAULT_NOTIFY_PREFS,
  type AppStats,
  type NotifyPrefs,
} from "@/lib/settings/notifyPrefs";
export { DEFAULT_NOTIFY_PREFS, type AppStats, type NotifyPrefs };

export interface AppState
  extends SpaceDesktopCompatibilitySlice,
    AgentChatDraftStoreSlice,
    ProviderLaunchDefaultsStoreSlice,
    SessionRuntimeStoreSlice,
    ScmReviewStoreSlice,
    SshHostsStoreSlice,
    AccountProfilesStoreSlice,
    AppPrefsStoreSlice,
    ProjectsStoreSlice,
    AgentRegistryStoreSlice {
  /** 고정된 pane (panePinKey → true) — 닫기 전 확인 (lib/panePin) */
  pinnedPanes: Record<string, boolean>;
  togglePanePin: (paneId: string) => void;
  layouts: Record<string, unknown>;
  /** 현재 포커스한 패널의 작업 폴더 컨텍스트 (오른쪽 파일 트리 루트) */
  focusCtx: FocusContext | null;
  /** 파일 트리에서 마지막으로 연 파일 — 트리 키별. 돌아왔을 때 보던 파일을 표시한다.
   *  펼침은 별도 스토어(`useFileTreeExpansion`)가 소유한다. */
  fileTreeSelected: Record<string, string>;
  // runtime (not persisted) — 세션 런타임 캐시·액션은 SessionRuntimeStoreSlice
  // (lib/sessions/runtime/sessionRuntimeStoreSlice)가 소유한다.
  /** 저장하지 않은 파일 편집 내용. 키는 `source:hostId:path`.
   *  dockview에 탭 닫기를 막는 훅이 없어서, 닫아도 초안을 여기 남겨두고
   *  같은 파일을 다시 열면 복구한다. persist 제외(앱 재시작하면 사라짐). */
  fileDrafts: Record<string, string>;

  setFocusCtx: (c: AppState["focusCtx"]) => void;
  /** 파일 트리에서 연 파일 기억 — 트리 키별. */
  setFileTreeSelected: (rootKey: string, path: string) => void;
  /** null이면 초안을 버린다(저장 완료·되돌리기). */
  setFileDraft: (key: string, content: string | null) => void;
}

// 4: tabOrder 기본값 recent -> manual. 기존 설치는 uiPrefs를 통째로 저장하고
//    있어서 기본값만 바꾸면 저장분이 이겨 아무에게도 도달하지 않는다.
// 5: 배선된 uiPrefs 기본값도 저장분과 함께 옮긴다; 6은 durable Desktop vocabulary를
//    canonical Space schema로 옮긴다.
import { DURABLE_APP_STORE_NAME, PERSIST_VERSION } from "@/lib/persistence/durableAppStoreName";
export { DURABLE_APP_STORE_NAME, PERSIST_VERSION };
export const durableAppStorage =
  createReferenceAwareLocalStorage<PersistedAppState>({
    convergeState: convergePersistedAppState,
    onCommitted: (name) => void publishDurableStoreChanged(name),
  });

const INITIAL_SPACES: Space[] = [DEFAULT_SPACE];
const INITIAL_SPACE_VISITS: Record<string, number> = {};

export const useStore = create<AppState>()(
  withDesktopStateCompatibility<Space, AppState, [["zustand/persist", PersistedAppState]]>(persist(
    (set, get) => ({
      spaces: INITIAL_SPACES,
      activeSpaceId: DEFAULT_SPACE.id,
      spaceVisits: INITIAL_SPACE_VISITS,
      desktops: INITIAL_SPACES,
      activeDesktopId: DEFAULT_SPACE.id,
      desktopVisits: INITIAL_SPACE_VISITS,
      pinnedPanes: {},
      layouts: {},
      focusCtx: null,
      fileTreeSelected: {},
      ...createAgentRegistryStoreSlice(set),
      ...createAgentChatDraftStoreSlice(set),
      ...createProjectsStoreSlice(set, get, async (candidate) => {
        const registration = await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => {
          const state = normalizePersistedState(current?.state ?? persistedSlice(get()));
          const registered = planProjectRegistration(state.projects, candidate);
          return {
            value: { version: PERSIST_VERSION, state: persistedSlice({ ...state, projects: registered.projects }) },
            result: registered,
          };
        });
        // Project the committed list; names and IDs are decided inside the
        // existing cross-window storage transaction, before any UI update.
        set({ projects: registration.projects });
        return registration.project;
      }),
      ...createAppPrefsStoreSlice(set),
      ...createAccountProfilesStoreSlice(set, get),
      ...createProviderLaunchDefaultsStoreSlice<AppState>(set),

      ...createSessionRuntimeStoreSlice(set),
      ...createScmReviewStoreSlice(set),
      ...createSshHostsStoreSlice(set, get),
      fileDrafts: {},

      setFocusCtx: (c) =>
        set((state) =>
          sameFocusContext(state.focusCtx, c) ? state : { focusCtx: c },
        ),

      setFileTreeSelected: (rootKey, path) =>
        set((s) => ({
          fileTreeSelected: capFileTreeRoots(s.fileTreeSelected, rootKey, path),
        })),

      addSpace: (opts) => {
        const space: Space = {
          id: `desk-${nanoid(6)}`,
          name: opts?.name?.trim() || nextSpaceName(get().spaces),
        };
        if (opts?.kind) space.kind = opts.kind;
        if (opts?.originSpaceId) space.originSpaceId = opts.originSpaceId;
        if (opts?.returnLayout !== undefined) space.returnLayout = opts.returnLayout;
        // Space creation can carry one atomic set of initial layout updates.
        // Popout stages an empty Space; its move commits after native creation.
        set((s) => ({
          spaces: [...s.spaces, space],
          ...(opts?.activate === false ? {} : { activeSpaceId: space.id }),
          ...(opts?.initialLayout !== undefined || opts?.layoutUpdates
            ? {
                layouts: {
                  ...s.layouts,
                  ...opts?.layoutUpdates,
									...(opts?.initialLayout !== undefined
										? { [space.id]: opts.initialLayout }
										: {}),
                },
              }
            : {}),
        }));
        return space.id;
      },

      removeSpace: (id) => {
        set((s) => {
          const spaces = s.spaces.filter((d) => d.id !== id);
          if (spaces.length === 0) {
            spaces.push({ ...DEFAULT_SPACE, id: `desk-${nanoid(6)}` });
          }
          const layouts = { ...s.layouts };
          delete layouts[id];
          return {
            spaces,
            layouts,
            // 이 데스크탑 pane들의 고정 기록도 함께 거둔다 (유령 고정 방지).
            pinnedPanes: dropPinnedPanesForDesktop(s.pinnedPanes, id),
            activeSpaceId:
							s.activeSpaceId === id
								? spaces[spaces.length - 1].id
								: s.activeSpaceId,
          };
        });
      },

      renameSpace: (id, name) =>
        set((s) => ({
          spaces: s.spaces.map((d) => (d.id === id ? { ...d, name } : d)),
        })),

      reorderSpace: (sourceId, targetId, position) =>
        set((s) => {
          const spaces = reorderDesktopItems(
            s.spaces,
            sourceId,
            targetId,
            position,
          );
          return spaces ? { spaces } : {};
        }),

      togglePanePin: (paneId) =>
        set((s) => ({ pinnedPanes: togglePinnedPane(s.pinnedPanes, paneId) })),

      // 최근순 정렬일 때만 기록한다 — 수동에서도 쓰면 전환마다 영속 슬라이스 전체가 직렬화된다.
      setActiveSpace: (id) =>
        set((s) =>
          (s.uiPrefs?.tabOrder ?? DEFAULT_UI_PREFS.tabOrder) !== "recent"
            ? { activeSpaceId: id }
            : {
                activeSpaceId: id,
                spaceVisits: recordDesktopVisit(s.spaceVisits, id, Date.now(), s.spaces.map((d) => d.id)),
              },
        ),

      saveLayout: (spaceId, layout) =>
        set((s) => ({
          layouts: {
            ...s.layouts,
            [spaceId]: normalizePersistedPaneLayout(layout),
          },
        })),

      addDesktop: (opts) =>
        get().addSpace({
          ...opts,
          originSpaceId: opts?.originDesktopId,
        }),
      removeDesktop: (id) => get().removeSpace(id),
      renameDesktop: (id, name) => get().renameSpace(id, name),
      reorderDesktop: (sourceId, targetId, position) =>
        get().reorderSpace(sourceId, targetId, position),
      setActiveDesktop: (id) => get().setActiveSpace(id),

      setFileDraft: (key, content) =>
        set((st) => {
          if (content === null) {
            if (!(key in st.fileDrafts)) return st;
            const next = { ...st.fileDrafts };
            delete next[key];
            return { fileDrafts: next };
          }
          if (st.fileDrafts[key] === content) return st;
          return { fileDrafts: { ...st.fileDrafts, [key]: content } };
        }),
    }),
    {
      name: DURABLE_APP_STORE_NAME,
      version: PERSIST_VERSION,
      storage: durableAppStorage,
      // 화살표로 감싼다 — persistedSlice의 매개변수 타입(PersistedAppState)이
      // 그대로 들어가면 zustand가 스토어 타입을 그쪽으로 좁혀 버린다.
      partialize: (state) => persistedSlice(state),
      migrate: (persistedState, fromVersion) =>
        migratePersistedState(persistedState, fromVersion),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizePersistedState(persistedState),
        // Rehydration restores client data, not the backend-owned launch policy.
        // SSH registration rehydrates before consuming this projection.
        ...(currentState.providerLaunchDefaults === null
          ? {}
          : {
              skipPermissions: currentState.skipPermissions,
              legacySkipPermissions: undefined,
            }),
      }),
    },
  )),
);

/** Reconcile this realm's dirty projection before replacing it from storage. */
export async function rehydrateAppStoreFromDurableStorage(): Promise<void> {
	await durableAppStorage.reconcile(DURABLE_APP_STORE_NAME);
	const persistence = useStore as unknown as {
		persist: { rehydrate: () => Promise<void> | void };
	};
	await Promise.resolve(persistence.persist.rehydrate());
}
