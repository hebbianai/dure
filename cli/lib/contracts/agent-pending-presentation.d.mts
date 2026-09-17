export interface PendingQuestionPresentation {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  allowOther: boolean;
  isSecret: boolean;
}

export interface PendingPermissionPresentation {
  title?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
}

export type PendingQuestionSelections = Record<number, ReadonlySet<number>>;
export type PendingQuestionOtherAnswers = Record<number, string>;

export function parsePendingPermissionPresentation(payload: unknown): PendingPermissionPresentation;
export function parsePendingQuestions(payload: unknown): PendingQuestionPresentation[] | undefined;
export function buildPendingQuestionAnswers(
  questions: readonly PendingQuestionPresentation[],
  selections: PendingQuestionSelections,
  otherAnswers: PendingQuestionOtherAnswers,
): Record<string, string> | undefined;

export interface PendingAnswerPresentation {
  decision?: "allow" | "deny";
  permission?: PendingPermissionPresentation;
  questions: { question: string; answer: string | null }[];
}
export function presentPendingAnswer(request: { kind: "permission" | "question"; payload: unknown }, answer: unknown): PendingAnswerPresentation;
