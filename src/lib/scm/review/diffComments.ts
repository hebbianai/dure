import { nanoid } from "nanoid";

/** diff 리뷰 코멘트 — 에이전트 산출물의 특정 파일/라인에 대한 사람의 지적.
 *  모아서 하나의 결정적 텍스트로 에이전트에게 회신한다(코멘트→프롬프트 루프).
 *  다른 리뷰 클라이언트의 diff-comment 포맷·스토어 패턴을 참고했다. */
export interface DiffComment {
  id: string;
  /** 이 코멘트가 붙은 에이전트(워크트리). */
  agentId: string;
  filePath: string;
  /** diff 상의 라인 번호. 0이면 파일 전체 범위. */
  line: number;
  /** 그 라인의 원문(있으면 프롬프트에 문맥으로 함께 보낸다). */
  lineText?: string;
  body: string;
  createdAt: number;
  /** 에이전트에 전달된 시각. 없으면 미전송. 수정하면 다시 미전송이 된다. */
  sentAt?: number;
}

export interface NewDiffComment {
  agentId: string;
  filePath: string;
  line: number;
  lineText?: string;
  body: string;
  now: number;
}

export function createDiffComment(input: NewDiffComment): DiffComment {
  return {
    id: nanoid(8),
    agentId: input.agentId,
    filePath: input.filePath,
    line: input.line,
    ...(input.lineText ? { lineText: input.lineText } : {}),
    body: input.body,
    createdAt: input.now,
  };
}

/** 코멘트 본문 수정 → 전달 표시를 지운다(edit-clears-sent). 이미 보낸 내용과
 *  달라졌으니 다시 보내야 한다는 규칙. body가 그대로면 변화 없음. */
export function updateDiffCommentBody(
  comment: DiffComment,
  body: string,
): DiffComment {
  if (comment.body === body) return comment;
  const next: DiffComment = { ...comment, body };
  delete next.sentAt;
  return next;
}

/** 전달 스냅샷과 일치할 때만 sentAt를 찍는다 — 전송 중에 코멘트가 바뀌면
 *  그 코멘트는 미전송으로 남긴다(delivery-snapshot matching). */
export function markDeliveredMatching(
  comments: readonly DiffComment[],
  deliveredSnapshot: readonly Pick<DiffComment, "id" | "body">[],
  now: number,
): DiffComment[] {
  const sent = new Map(deliveredSnapshot.map((s) => [s.id, s.body]));
  return comments.map((c) =>
    sent.get(c.id) === c.body ? { ...c, sentAt: now } : c,
  );
}

/** 아직 안 보낸(또는 보낸 뒤 수정된) 코멘트만. */
export function unsentComments(
  comments: readonly DiffComment[],
): DiffComment[] {
  return comments.filter((c) => c.sentAt === undefined);
}

function escapeCommentBody(body: string): string {
  return body
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function locationLabel(c: DiffComment): string {
  return c.line === 0 ? "Scope: file" : `Line: ${c.line}`;
}

/** 코멘트 하나를 결정적·quote-safe 텍스트로. 에이전트가 파싱하기 좋게 고정 포맷.
 *  이 포맷이 리뷰 노트와 에이전트 사이의 계약이므로 함부로 바꾸지 않는다. */
export function formatDiffComment(c: DiffComment): string {
  const parts = [`File: ${c.filePath}`, locationLabel(c)];
  if (c.lineText) parts.push(`Context: ${c.lineText.trim().slice(0, 200)}`);
  parts.push(`Comment: "${escapeCommentBody(c.body)}"`);
  return parts.join("\n");
}

/** 여러 코멘트를 하나의 회신 프롬프트로. 파일→라인 순으로 안정 정렬. */
export function formatDiffComments(comments: readonly DiffComment[]): string {
  if (comments.length === 0) return "";
  const ordered = [...comments].sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line,
  );
  const header =
    "Please address these review comments on your changes, then continue:";
  return [header, "", ordered.map(formatDiffComment).join("\n\n")].join("\n");
}
