// 사이드바 SCM → 소스 제어 창으로 상세 요청 전달 (localStorage 브로드캐스트).
// 창은 별도 웹뷰라 직접 호출이 안 된다 — focusCtxBroadcast와 같은 storage
// 이벤트 문법. 저장소 좌표(path·kind·host)를 실어 보내 수신 쪽에서 복원한다.
import type { Project } from "@/types";
import { openSourceControlWindow } from "@/lib/workspace/window/windows";

export interface ScmDetailRequest {
  kind: "file" | "commit";
  /** file이면 경로, commit이면 해시 */
  ref: string;
  /** gitExec용 저장소 좌표 — 창 쪽에서 합성 Project로 복원한다.
   *  (사이드바의 focus 프로젝트는 합성 id라 id 전달은 의미가 없다.) */
  project: { path: string; name: string; kind: string; sshHostId?: string };
  /** 발행 시각(ms) — 창이 늦게 뜰 때의 초기 소비 신선도 판정용 */
  at: number;
}

const KEY = "agent-ide-scm-detail";
/** 창 기동(웹뷰 로드 포함)을 기다려주는 초기 소비 허용 시간. */
const FRESH_MS = 10_000;

function publishScmDetail(request: Omit<ScmDetailRequest, "at">) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...request, at: Date.now() }));
  } catch {
    // storage 불가 환경(테스트 등)에서는 조용히 무시 — 창은 수동 탐색 가능
  }
}

function parse(raw: string | null): ScmDetailRequest | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ScmDetailRequest>;
    if (
      (v.kind === "file" || v.kind === "commit") &&
      typeof v.ref === "string" &&
      typeof v.project?.path === "string" &&
      typeof v.project?.name === "string" &&
      typeof v.project?.kind === "string" &&
      typeof v.at === "number"
    ) {
      return v as ScmDetailRequest;
    }
  } catch {
    // 손상 값은 무시
  }
  return null;
}

/** 창 기동 직후 1회 — 방금(FRESH_MS 안에) 발행된 요청만 소비한다. */
export function consumeFreshScmDetail(): ScmDetailRequest | null {
  const request = parse(localStorage.getItem(KEY));
  if (!request || Date.now() - request.at > FRESH_MS) return null;
  return request;
}

/** 살아 있는 창의 실시간 수신. 해제 함수를 돌려준다. */
export function onScmDetail(callback: (request: ScmDetailRequest) => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    const request = parse(event.newValue);
    if (request) callback(request);
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

/** 사이드바에서 행 클릭 → 소스 제어 창을 열고(이미 있으면 포커스) 상세 요청 발행. */
export function openScmDetailInWindow(
  kind: "file" | "commit",
  project: Project,
  ref: string,
) {
  void openSourceControlWindow();
  publishScmDetail({
    kind,
    ref,
    project: {
      path: project.path,
      name: project.name,
      kind: project.kind,
      sshHostId: project.sshHostId,
    },
  });
}
