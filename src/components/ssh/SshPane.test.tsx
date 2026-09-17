// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SshConfigScan, SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({
  sshCredentialClaimActivate: vi.fn(),
  sshCredentialClaimRetire: vi.fn(),
  sshCredentialClaimStage: vi.fn(),
  sshConfigHosts: vi.fn(),
  sshSecretSet: vi.fn(),
  openSshTerminalPanel: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
  message: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  sshCredentialClaimActivate: mocks.sshCredentialClaimActivate,
  sshCredentialClaimRetire: mocks.sshCredentialClaimRetire,
  sshCredentialClaimStage: mocks.sshCredentialClaimStage,
  sshConfigHosts: mocks.sshConfigHosts,
  sshSecretSet: mocks.sshSecretSet,
}));
vi.mock("@/lib/workspace/dock", () => ({ openSshTerminalPanel: mocks.openSshTerminalPanel }));

import { AddSshHostDialog } from "@/components/ssh/SshHostDialogs";
import { SshPane } from "@/components/ssh/SshPane";
import {
  SSH_CONFIG_HOST_DRAG_TYPE,
  sshConfigHostDraft,
  sshConfigHostId,
} from "@/lib/ssh/sshConfigRegistration";
import {
  normalizePersistedState,
  persistedSlice,
} from "@/lib/persistence/persistedAppState";
import {
  DURABLE_APP_STORE_NAME,
  durableAppStorage,
  PERSIST_VERSION,
  useStore,
} from "@/store";

const scan: SshConfigScan = {
  files: [
    {
      path: "/home/me/.ssh/config",
      displayPath: "~/.ssh/config",
      hosts: [
        { alias: "gate1", hostName: "10.0.0.1", user: "ubuntu", port: 22 },
        { alias: "clink", hostName: "clink.example.com" },
      ],
    },
  ],
  defaultUser: "me",
};

/** 등록되고 나면 같은 호스트가 등록 목록에도 생긴다 — 드래그 가능한 설정 파일 행만
 *  고른다. 행은 user@host:port를 data-ssh-host로 든다(OS 툴팁 title은 2026-09-09에
 *  걷어냈다). */
function configRow(target: string): HTMLElement {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-ssh-host="${target}"]`),
  ).find((el) => el.getAttribute("draggable") === "true");
  if (!row) throw new Error(`설정 파일 행을 찾지 못했습니다: ${target}`);
  return row;
}

/** jsdom에는 DataTransfer가 없다 — 드래그가 실제로 쓰는 부분만 흉내낸다. */
function makeDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "none",
    dropEffect: "none",
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
    get types() {
      return [...store.keys()];
    },
  };
}

async function writeDurableSshProjection(update: {
  sshHosts: SshHostConfig[];
  projects?: Project[];
}): Promise<void> {
  await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => {
    const state = normalizePersistedState(current?.state ?? {});
    return {
      value: {
        version: PERSIST_VERSION,
        state: persistedSlice({
          ...state,
          sshHosts: update.sshHosts,
          projects: update.projects ?? state.projects,
        }),
      },
      result: undefined,
    };
  });
}

describe("SshPane — ~/.ssh/config 호스트", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.sshConfigHosts.mockResolvedValue(scan);
    mocks.sshCredentialClaimActivate.mockResolvedValue(undefined);
    mocks.sshCredentialClaimRetire.mockResolvedValue(undefined);
    mocks.sshCredentialClaimStage.mockResolvedValue(undefined);
    mocks.sshSecretSet.mockResolvedValue(undefined);
    await durableAppStorage.flush();
    localStorage.clear();
    useStore.setState({
      sshHosts: [],
      projects: [],
      agents: [],
      sshStates: {},
      activeDesktopId: "desktop-main",
    });
    await durableAppStorage.flush();
  });

  afterEach(cleanup);

  it("Connect registers a detected host and opens its terminal exactly once", async () => {
    render(<SshPane />);
    await screen.findByText("~/.ssh/config");

    fireEvent.click(
      within(configRow("ubuntu@10.0.0.1:22")).getByRole("button", {
        name: "연결",
      }),
    );

    await waitFor(() => expect(mocks.openSshTerminalPanel).toHaveBeenCalledTimes(1));
    const [host] = useStore.getState().sshHosts;
    expect(host).toMatchObject({ name: "gate1", host: "10.0.0.1", user: "ubuntu" });
    expect(mocks.openSshTerminalPanel).toHaveBeenCalledWith(
      "desktop-main",
      host.id,
      "gate1",
      undefined,
      undefined,
    );

    fireEvent.click(
      within(configRow("ubuntu@10.0.0.1:22")).getByRole("button", {
        name: "연결",
      }),
    );
    await waitFor(() => expect(mocks.openSshTerminalPanel).toHaveBeenCalledTimes(2));
    expect(useStore.getState().sshHosts).toEqual([host]);
    expect(mocks.openSshTerminalPanel).toHaveBeenLastCalledWith(
      "desktop-main",
      host.id,
      "gate1",
      undefined,
      undefined,
    );
  });

  it("Connect opens a registered host exactly once without registering it again", async () => {
    const host: SshHostConfig = {
      id: "saved-host",
      name: "Saved server",
      host: "saved.example.com",
      port: 22,
      user: "me",
      auth: "auto",
    };
    useStore.setState({ sshHosts: [host] });
    render(<SshPane />);

    fireEvent.click(
      within(
        document.querySelector<HTMLElement>('[data-ssh-host="me@saved.example.com:22"]')!,
      ).getByRole("button", {
        name: "연결",
      }),
    );

    expect(mocks.openSshTerminalPanel).toHaveBeenCalledTimes(1);
    expect(mocks.openSshTerminalPanel).toHaveBeenCalledWith(
      "desktop-main",
      host.id,
      host.name,
      undefined,
      undefined,
    );
    expect(useStore.getState().sshHosts).toEqual([host]);
    expect(mocks.sshCredentialClaimStage).not.toHaveBeenCalled();
  });

  /** 구획은 기본 펼침이다 — 시안이 펼친 상태를 보여준다. 접는 캐럿은 평소
   *  숨어 있다가 hover에서만 보이므로(소유자 결정 2026-08-12), 처음 화면에는
   *  설정 파일 호스트가 그대로 있다. 예전의 "기본 접힘"과 반대 계약이다. */
  it("구획은 기본 펼침이고 라벨을 눌러 접을 수 있다", async () => {
    render(<SshPane />);

    const group = (await screen.findByText("~/.ssh/config")).closest("button")!;
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("gate1")).toBeTruthy();
    expect(screen.getByText("clink")).toBeTruthy();

    fireEvent.click(group);
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("gate1")).toBeNull();
  });

  /** 시안 559:39363의 액션 순서는 ChevronDown → (FolderPlus2) → Plus다. 캐럿이
   *  라벨 쪽에 붙는 것은 그것만 이 구획 자체를 여닫기 때문이고, 추가는 목록에
   *  무언가를 더하는 것이라 바깥에 선다. 순서가 뒤집히면 hover 때 캐럿 위치가
   *  구획마다 달라져 눈이 매번 다시 찾는다. */
  it("구획 액션은 캐럿이 안쪽, 추가가 바깥쪽 순이다", async () => {
    render(<SshPane />);

    const label = (await screen.findByText("등록된 호스트")).closest("button")!;
    const row = label.parentElement;
    // The group row is an inset pill on the File tab's SidebarGroupLabel
    // geometry (32px row, 8px padding). The old `-mx-1.5` did the opposite —
    // it cancelled the viewport inset so the row bled to the pane edges.
    expect(row?.className).toContain("h-8");
    expect(row?.className).toContain("px-2");
    expect(row?.className).not.toContain("-mx-");
    // Accessible names: the label button is named by its text, the icon
    // controls by aria-label. None of them carries an OS tooltip (2026-09-09).
    const names = [...(row?.querySelectorAll("button") ?? [])].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
    );
    expect(names).toEqual(["등록된 호스트", "SSH 호스트 추가"]);
  });

  it("호스트와 SSH 설정이 모두 없어도 추가 액션은 남는다", async () => {
    mocks.sshConfigHosts.mockResolvedValue({ files: [], defaultUser: "me" });
    render(<SshPane />);

    // With nothing registered and no config file, the pane is empty rather
    // than one of its sections, so it takes the whole-pane empty state and the
    // "Registered hosts" label goes with it — a label above centred content is
    // neither shape (2026-09-08). The action still has to be reachable, from
    // the pane header and from the empty state itself.
    const add = await screen.findAllByRole("button", { name: "SSH 호스트 추가" });
    expect(add.length).toBeGreaterThan(0);
    expect(screen.queryByText("등록된 호스트")).toBeNull();
    expect(screen.getByText("등록된 호스트가 없습니다")).toBeTruthy();
  });

  it("빈 호스트 상태는 죽은 텍스트가 아니라 추가 액션을 준다", async () => {
    // 빈 상태 = 실제 동작하는 액션(onboarding-competitor-research 채택 패턴 #3).
    // 같은 화면 위 + 아이콘과 동일한 폼을 연다 — 빈 줄이 다음 행동을 직접 준다.
    mocks.sshConfigHosts.mockResolvedValue({ files: [], defaultUser: "me" });
    render(<SshPane />);

    const empty = await screen.findByRole("status");
    within(empty).getByText("등록된 호스트가 없습니다");
    fireEvent.click(
      within(empty).getByRole("button", { name: "SSH 호스트 추가" }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("추가 액션을 누르면 SSH 호스트 폼을 연다", async () => {
    render(<SshPane />);

    // The header's copy comes first in the tree; the group row's hover `+`
    // opens the same form.
    fireEvent.click((await screen.findAllByRole("button", { name: "SSH 호스트 추가" }))[0]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "SSH 호스트 추가" })).toBeTruthy();
  });

  it("Add does not turn a repeated config route into a credential edit", async () => {
    const draft = sshConfigHostDraft(scan.files[0].hosts[0], scan.defaultUser);
    const existing = {
      ...draft,
      id: sshConfigHostId(draft.sshConfigAlias),
      registrationGeneration: "existing-generation",
    };
    useStore.setState({
      sshHosts: [
        {
          ...existing,
          name: "my gate",
          auth: "password",
          secretId: "credential-1",
        },
      ],
    });
    await writeDurableSshProjection({
      sshHosts: useStore.getState().sshHosts,
    });
    const onClose = vi.fn();

    render(<AddSshHostDialog prefill={draft} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "추가" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(useStore.getState().sshHosts).toEqual([
      expect.objectContaining({
        id: existing.id,
        name: "my gate",
        auth: "password",
        secretId: "credential-1",
      }),
    ]);
    expect(mocks.sshCredentialClaimRetire).not.toHaveBeenCalled();
  });

  it("credential failure preserves a same-ID Host successor that acquired a Project", async () => {
    const draft = {
      ...sshConfigHostDraft(scan.files[0].hosts[0], scan.defaultUser),
      auth: "password" as const,
    };
    const successorId = sshConfigHostId(draft.sshConfigAlias);
    mocks.sshSecretSet.mockImplementation(async () => {
      useStore.setState({
        sshHosts: [
          {
            ...draft,
            id: successorId,
            registrationGeneration: "successor-generation",
            host: "successor.example.test",
          },
        ],
        projects: [
          {
            id: "project-successor",
            name: "Successor",
            path: "/srv/successor",
            kind: "ssh",
            sshHostId: successorId,
            isRepo: true,
          },
        ],
      });
      await writeDurableSshProjection({
        sshHosts: useStore.getState().sshHosts,
        projects: useStore.getState().projects,
      });
      throw new Error("credential save failed");
    });

    render(<AddSshHostDialog prefill={draft} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("비밀번호"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "추가" }));

    await screen.findByText("Error: credential save failed");
    expect(useStore.getState().sshHosts).toEqual([
      expect.objectContaining({
        id: successorId,
        host: "successor.example.test",
      }),
    ]);
    expect(useStore.getState().projects).toEqual([
      expect.objectContaining({
        id: "project-successor",
        sshHostId: successorId,
      }),
    ]);
  });

  it("retires a completed credential when the same config route wins during I/O", async () => {
    const draft = {
      ...sshConfigHostDraft(scan.files[0].hosts[0], scan.defaultUser),
      auth: "password" as const,
    };
    const onClose = vi.fn();
    const successorId = sshConfigHostId(draft.sshConfigAlias);
    mocks.sshSecretSet.mockImplementation(async () => {
      useStore.setState({
        sshHosts: [
          {
            ...draft,
            id: successorId,
            registrationGeneration: "successor-generation",
            host: "successor.example.test",
          },
        ],
      });
      await writeDurableSshProjection({
        sshHosts: useStore.getState().sshHosts,
      });
    });

    render(<AddSshHostDialog prefill={draft} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("비밀번호"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "추가" }));

    await waitFor(() => expect(mocks.sshCredentialClaimRetire).toHaveBeenCalledOnce());
    const writtenSecretId = mocks.sshSecretSet.mock.calls[0]?.[0];
    expect(writtenSecretId).toMatch(/^ssh-[A-Za-z0-9_-]{32}$/);
    expect(mocks.sshCredentialClaimRetire).toHaveBeenCalledWith([
      expect.objectContaining({ id: writtenSecretId, hostId: successorId }),
    ]);
    const [successor] = useStore.getState().sshHosts;
    expect(successor).toEqual(
      expect.objectContaining({
        id: successorId,
        registrationGeneration: "successor-generation",
        host: "successor.example.test",
      }),
    );
    expect(successor.secretId).toBeUndefined();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not leave an incomplete config registration when credential setup fails", async () => {
    const draft = {
      ...sshConfigHostDraft(scan.files[0].hosts[0], scan.defaultUser),
      auth: "password" as const,
    };
    mocks.sshSecretSet.mockRejectedValueOnce(new Error("credential save failed"));

    render(<AddSshHostDialog prefill={draft} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("비밀번호"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "추가" }));

    await screen.findByText("Error: credential save failed");
    expect(useStore.getState().sshHosts).toEqual([]);
  });

  it("설정 파일 호스트를 등록 목록에 떨어뜨리면 등록된다", async () => {
    render(<SshPane />);
    await screen.findByText("~/.ssh/config");

    const source = configRow("ubuntu@10.0.0.1:22");
    const target = screen.getByText("등록된 호스트");
    const dataTransfer = makeDataTransfer();

    fireEvent.dragStart(source, { dataTransfer });
    expect(dataTransfer.getData(SSH_CONFIG_HOST_DRAG_TYPE)).not.toBe("");
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    await waitFor(() =>
      expect(
        useStore.getState().sshHosts.map((h) => ({
          name: h.name,
          sshConfigAlias: h.sshConfigAlias,
          host: h.host,
          port: h.port,
          user: h.user,
          auth: h.auth,
        })),
      ).toEqual([
        {
          name: "gate1",
          sshConfigAlias: "gate1",
          host: "10.0.0.1",
          port: 22,
          user: "ubuntu",
          auth: "auto",
        },
      ]),
    );
  });

  it("HMR 전 세대의 SSH drag MIME은 입력으로만 계속 받는다", async () => {
    render(<SshPane />);
    await screen.findByText("등록된 호스트");
    const dataTransfer = makeDataTransfer();
    dataTransfer.setData(
      "hebbian/ssh-config-host",
      JSON.stringify({
        name: "legacy",
        host: "legacy.example.com",
        port: 22,
        user: "me",
        auth: "auto",
      }),
    );

    const target = screen.getByText("등록된 호스트");
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    await waitFor(() =>
      expect(useStore.getState().sshHosts.map((host) => host.name)).toEqual([
        "legacy",
      ]),
    );
    expect(dataTransfer.getData(SSH_CONFIG_HOST_DRAG_TYPE)).toBe("");
  });

  it("User가 없는 호스트는 로컬 사용자명으로 등록된다", async () => {
    render(<SshPane />);
    await screen.findByText("~/.ssh/config");

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(configRow("me@clink.example.com:22"), { dataTransfer });
    fireEvent.drop(screen.getByText("등록된 호스트"), { dataTransfer });

    await waitFor(() =>
      expect(useStore.getState().sshHosts.map((h) => h.user)).toEqual(["me"]),
    );
  });

  it("같은 호스트를 두 번 떨어뜨려도 중복 등록되지 않는다", async () => {
    render(<SshPane />);
    await screen.findByText("~/.ssh/config");

    const target = screen.getByText("등록된 호스트");
    for (let i = 0; i < 2; i++) {
      const dataTransfer = makeDataTransfer();
      fireEvent.dragStart(configRow("ubuntu@10.0.0.1:22"), { dataTransfer });
      fireEvent.drop(target, { dataTransfer });
    }

    await waitFor(() => {
      expect(useStore.getState().sshHosts).toHaveLength(1);
      expect(screen.getByText("등록됨")).toBeTruthy();
    });
  });

  it("우리 페이로드가 아닌 드롭은 무시한다", async () => {
    render(<SshPane />);
    await screen.findByText("~/.ssh/config");

    const dataTransfer = makeDataTransfer();
    dataTransfer.setData("text/plain", "/some/dragged/file");
    fireEvent.drop(screen.getByText("등록된 호스트"), { dataTransfer });

    expect(useStore.getState().sshHosts).toEqual([]);
  });

  it("우클릭 메뉴에서 터미널을 열지 않고 등록만 할 수 있다", async () => {
    render(<SshPane />);
    await screen.findByText("~/.ssh/config");

    fireEvent.contextMenu(configRow("ubuntu@10.0.0.1:22"));
    const item = await screen.findByText("등록된 호스트에 추가");
    fireEvent.click(item);

    await waitFor(() =>
      expect(useStore.getState().sshHosts.map((h) => h.name)).toEqual(["gate1"]),
    );
    expect(mocks.openSshTerminalPanel).not.toHaveBeenCalled();
  });
});
