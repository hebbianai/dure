// 에이전트 추가 다이얼로그 (시안 2256:29002 / 29090).
//
// 이름은 호출부 호환을 위해 유지한다. 내용은 예전 2단계(여기서 디렉터리를
// 고르고 AddAgentDialog로 넘기던 흐름)를 한 화면으로 합친 것이다 — 본체는
// addAgent/AddAgentBody, 이 파일은 셸(헤더·폴더 찾기·SSH 호스트 추가)만 맡는다.

import { useEffect, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import { useStore } from "@/store";
import { t } from "@/lib/i18n";
import { homeDir } from "@/lib/ipc";
import { inspectLocalProject } from "@/lib/spaces/projectAdd";
import type { Agent, Project, Provider } from "@/types";
import { AddAgentBody } from "@/components/agents/addAgent/AddAgentBody";
import { AddRemoteProjectDialog, AddSshHostDialog } from "@/components/ssh/SshHostDialogs";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";

export function WorktreeAgentDialog({
  desktopId,
  host,
  initialPath,
  initialProvider,
  onClose,
  onCreated,
}: {
  desktopId: string;
  /** SSH host에서 열도록 시작했으면 그 host — 없으면 로컬 */
  host?: { id: string; name: string };
  /** 지정 시 그 위치를 프로젝트로 먼저 확보한다 */
  initialPath?: string;
  initialProvider?: Provider;
  onClose: () => void;
  onCreated?: (agent: Agent) => void;
}) {
  const ensureProjectForPath = useStore((state) => state.ensureProjectForPath);
  const [browsingHostId, setBrowsingHostId] = useState<string | null>(null);
  const [addingHost, setAddingHost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaultProject, setDefaultProject] = useState<Project | null>(null);
  // 확보한 프로젝트를 본체가 실제로 고르게 하려면 id를 넘겨야 한다. 확보만 하고
  // 버리면 본체는 호스트의 첫 프로젝트를 계속 선택한 채로 있는다. seq를 함께
  // 올려 같은 폴더를 다시 골라도 반영되게 한다.
  const [selection, setSelection] = useState<{ projectId: string; seq: number } | null>(
    null,
  );
  const select = (projectId: string) =>
    setSelection((previous) => ({ projectId, seq: (previous?.seq ?? 0) + 1 }));

  // Home is a usable local working folder even before any Project exists.
  // Inspect it without registering it; submission converges through the same
  // ensureProjectForPath path as every other location.
  useEffect(() => {
    let disposed = false;
    void homeDir()
      .then(inspectLocalProject)
      .then((project) => {
        if (!disposed) setDefaultProject(project);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  // 미리 정해진 위치는 목록에 없을 수 있으므로 먼저 프로젝트로 확보해 둔다.
  useEffect(() => {
    if (!initialPath) return;
    void ensureProjectForPath(initialPath, host?.id)
      .then((project) => select(project.id))
      .catch((cause) => setError(String(cause)));
    // 마운트 시 고정 — 재실행하지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 목록에 없는 폴더: 로컬은 네이티브 선택, 원격은 SSH 브라우저. */
  const browse = async (hostId: string | null) => {
    if (hostId) {
      setBrowsingHostId(hostId);
      return;
    }
    try {
      const dir = await openFolderDialog({
        directory: true,
        multiple: false,
        title: t("common.chooseWorkingFolder"),
      });
      if (typeof dir === "string") {
        const project = await ensureProjectForPath(dir);
        select(project.id);
      }
    } catch (cause) {
      setError(String(cause));
    }
  };

  // 보조 다이얼로그는 본체를 '대체'하지 않고 그 위에 얹는다. early return하면
  // AddAgentBody가 언마운트돼 고른 호스트·브랜치·프로바이더가 전부 초기화된다 —
  // 폴더 하나 찾아오는 사이에 폼을 통째로 잃는 셈이었다.
  const overlay = browsingHostId ? (
    <AddRemoteProjectDialog
      hostId={browsingHostId}
      onResolved={(project) => {
        select(project.id);
        setBrowsingHostId(null);
      }}
      onClose={() => setBrowsingHostId(null)}
    />
  ) : addingHost ? (
    <AddSshHostDialog onClose={() => setAddingHost(false)} />
  ) : null;

  return (
    <>
      {overlay}
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          showCloseButton={false}
          dismiss="escape-only"
          style={{ width: "min(94vw, 698px)", maxWidth: "698px" }}
          className="block gap-0 overflow-hidden p-0"
        >
          {/* 2256:29005 — 제목 줄, 아래 헤어라인 */}
          <div className="relative border-b border-glass-hairline px-6 pt-5 pb-4">
            <DialogTitle className="text-lg leading-7 font-medium text-foreground">
              {t("agents.add.title")}
            </DialogTitle>
            <p className="text-xs leading-4 text-muted-foreground">
              {t("agents.add.chooseWhereAndWhat")}
            </p>
            <IconButton
              onClick={onClose}
              title={t("common.close")}
              className="absolute top-[14px] right-[14px]"
            >
              <X />
            </IconButton>
          </div>
          {error && (
            <p className="px-6 pt-2 text-meta break-all text-destructive">{error}</p>
          )}
          <AddAgentBody
            desktopId={desktopId}
            initialHostId={host?.id ?? null}
            initialProvider={initialProvider}
            defaultProject={defaultProject}
            selection={selection}
            onClose={onClose}
            onCreated={onCreated}
            onBrowse={(hostId) => void browse(hostId)}
            onAddHost={() => setAddingHost(true)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
