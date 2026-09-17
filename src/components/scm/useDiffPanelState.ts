// DiffPanel's designated store-wiring point (cluster wiring hook). Every
// global-store subscription the diff review pane needs lives here; the
// component consumes these hooks and keeps rendering only. Each selector
// stays its own useStore subscription so rerender semantics match the
// previous inline wiring exactly.
import { DEFAULT_UI_PREFS } from "@/lib/settings/uiPrefs";
import { useStore } from "@/store";

/** Review-source wiring — the legacy agent/project resolution plus the diff
 *  view ui prefs that seed the pane's local view state. */
export function useDiffPanelState(legacyAgentId: string | undefined) {
  const legacyAgent = useStore((s) => s.agents.find((a) => a.id === legacyAgentId));
  const project = useStore((s) => s.projects.find((p) => p.id === legacyAgent?.projectId));
  // 좌측 파일 목록 폭. 드래그 중에는 로컬 state로 따라가고 놓을 때 한 번만
  // 저장한다 — 매 mousemove마다 persist하면 스토어 쓰기가 드래그를 따라간다.
  const storedListWidth = useStore(
    (state) => state.uiPrefs?.diffFileListWidth ?? DEFAULT_UI_PREFS.diffFileListWidth,
  );
  // 설정 › 일반 › 편집기 — 긴 diff 줄을 접을지, 파일 목록을 처음부터 펼칠지.
  const diffWordWrap = useStore(
    (state) => state.uiPrefs?.diffWordWrap ?? DEFAULT_UI_PREFS.diffWordWrap,
  );
  const defaultDiffFileTree = useStore(
    (state) => state.uiPrefs?.defaultDiffFileTree ?? DEFAULT_UI_PREFS.defaultDiffFileTree,
  );
  const defaultDiffView = useStore(
    (state) => state.uiPrefs?.defaultDiffView ?? DEFAULT_UI_PREFS.defaultDiffView,
  );
  // 로컬 markdown 메모 컨트롤 — diff 리뷰 코멘트가 곧 그 메모이고, 아래
  // 전송 버튼이 '에이전트 전달 작업'이다. 끄면 diff를 읽기 전용으로 본다.
  const markdownReviewNotes = useStore(
    (state) => state.uiPrefs?.markdownReviewNotes ?? DEFAULT_UI_PREFS.markdownReviewNotes,
  );
  return {
    legacyAgent,
    project,
    storedListWidth,
    diffWordWrap,
    defaultDiffFileTree,
    defaultDiffView,
    markdownReviewNotes,
  };
}

/** Review-comment loop wiring — the feedback agent, its comment list, and the
 *  comment actions. Separate from useDiffPanelState because feedbackAgentId
 *  is only resolved after the durable review target loads. */
export function useDiffReviewCommentsState(feedbackAgentId: string | undefined) {
  const agent = useStore((s) => s.agents.find((candidate) => candidate.id === feedbackAgentId));
  const comments = useStore((s) => s.diffComments[feedbackAgentId ?? ""]);
  const addDiffComment = useStore((s) => s.addDiffComment);
  const removeDiffComment = useStore((s) => s.removeDiffComment);
  const markDiffCommentsSent = useStore((s) => s.markDiffCommentsSent);
  return { agent, comments, addDiffComment, removeDiffComment, markDiffCommentsSent };
}

/** Deferred pref write used on resize mouseup — reads the store at call time
 *  exactly like the previous inline useStore.getState() call. */
export function persistDiffFileListWidth(width: number) {
  useStore.getState().setUiPrefs({
    diffFileListWidth: width,
  });
}
