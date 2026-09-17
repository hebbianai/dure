/**
 * The sheets the source-control screen opens over itself: committing, and
 * discarding. Figma `dure-UI` 3050:81250, 3050:81351, 3048:81145.
 *
 * # Why sheets and not screens
 *
 * Each is drawn over the thing it acts on, and each is about what is under it:
 * the commit sheet names the files it is about, and the confirmation names
 * what it is about to throw away. A screen would take that away at the moment
 * somebody most needs it.
 *
 * # Why they share a file
 *
 * They share their subject — the source-control screen — and nothing else. The
 * frame they all stand in (the grip, the panel, the scrim) moved to
 * [`sheetShell`] the day the home screen opened one too; keeping a second copy
 * here would have let the two drift, and a sheet that sits two pixels
 * differently from its sibling reads as a bug in the one you happen to see
 * second.
 *
 * The branch switcher and the reviewer sheet that used to live here left with
 * the rest of the git surface (2026-09-04): this screen is the changes and a
 * commit, nothing more.
 */

import { element, sheetShell } from "./dom";
import { t } from "./i18n";

export interface CommitSheetModel {
  /** How many files this commit is about, and which branch it lands on. */
  readonly files: number;
  readonly branch?: string;
  readonly message: string;
  readonly busy?: boolean;
  readonly error?: string;
}

export interface CommitSheetActions {
  readonly dismiss: () => void;
  readonly edit: (message: string) => void;
  readonly submit: () => void;
}

/** The commit sheet. Figma 3050:81250 (a message written), 3050:81351 (none yet). */
export function renderCommitSheet(
  model: CommitSheetModel,
  actions: CommitSheetActions,
): HTMLElement {
  const busy = model.busy === true;
  const { host, panel } = sheetShell(t("커밋"), () => {
    if (!busy) actions.dismiss();
  });

  // 시안의 "3개 파일 · fix/payment-retry". 브랜치를 모르면 파일 수만 말한다 —
  // 지어낸 이름 위에 커밋을 만들게 두지 않는다.
  const facts =
    model.branch === undefined
      ? t("{count}개 파일", { count: model.files })
      : t("{count}개 파일 · {branch}", { count: model.files, branch: model.branch });
  panel.append(element("p", "sheet__note", facts));

  const field = element("textarea", "form__input prform__textarea");
  field.value = model.message;
  field.rows = 3;
  field.placeholder = t("무엇을 바꿨는지");
  field.setAttribute("aria-label", t("메시지"));
  field.disabled = busy;
  // `input`, not `change`: the button follows what is in the field right now,
  // and `change` fires only on blur.
  field.addEventListener("input", () => {
    if (busy) return;
    actions.edit(field.value);
    submit.disabled = field.value.trim().length === 0;
    host.querySelector(".prform__error")?.remove();
  });
  const labelled = element("div", "prform__field");
  labelled.append(element("span", "prform__label", t("메시지")));
  labelled.append(field);
  panel.append(labelled);

  if (model.error !== undefined) {
    panel.append(element("p", "prform__error", model.error));
  }

  const submit = element(
    "button",
    "pair-button pair-button--solid pair-button--block",
    busy ? t("커밋하는 중…") : t("커밋"),
  );
  submit.type = "button";
  // 빈 메시지는 git 도 거절한다. 여기서 막는 것이 20초 뒤에 그 문장을 받는
  // 것보다 낫다. 두 번 누르면 커밋이 둘 생기므로 진행 중에도 죽는다.
  submit.disabled = busy || model.message.trim().length === 0;
  submit.addEventListener("click", actions.submit);
  panel.append(submit);

  const cancel = element("button", "pair-button pair-button--ghost pair-button--block", t("취소"));
  cancel.type = "button";
  cancel.disabled = busy;
  cancel.addEventListener("click", actions.dismiss);
  panel.append(cancel);
  return host;
}
