/**
 * One file's patch — what a row of the changed-file list opens.
 * Figma `dure-UI` 3048:81027.
 *
 * # The two buttons under it
 *
 * 변경 되돌리기 and 커밋에 포함 are drawn only when this file can actually be
 * either — which means the answering side is a paired laptop (an SSH box's
 * pairing key is read-only) and the file has changes that are not committed
 * yet. On a file already committed on this branch there is nothing to discard
 * and nothing to commit, and a live-looking button that refuses is worse than
 * a missing one: the one under 변경 되돌리기 would be read as "your work is
 * gone" either way.
 *
 * 되돌리기 never acts from here. It asks, and the screen that owns the list
 * puts the confirmation up — the same dialog as the list's own, so there is
 * one place where "this cannot be undone" is said.
 */

import iconChevronLeft from "./assets/icon-chevron-left.svg";
import { element, glyph, loader } from "./dom";
import { type DiffRow, parseUnifiedDiff } from "./fileDiff";
import { t } from "./i18n";
import type { FileDiffOutcome } from "./ipc";

/**
 * What the laptop or the box said about this file.
 *
 * `binary` is not a failure and not an empty patch. A screen that folds the
 * three together tells somebody a PNG is unchanged when nobody compared it.
 */
export type FilePatch =
  | { readonly kind: "loading" }
  | {
      readonly kind: "read";
      readonly patch: string;
      /** The body was cut at a ceiling. Never silent — see the footer. */
      readonly truncated: boolean;
      readonly added?: number;
      readonly deleted?: number;
    }
  | { readonly kind: "binary" }
  | { readonly kind: "failed"; readonly detail: string };

export interface FileDiffModel {
  /** The path, as the list gave it. The header shows its last segment. */
  readonly path: string;
  /** The commit this came from, when the tap came from a commit's file list. */
  readonly commit?: string;
  readonly patch: FilePatch;
}

export interface FileDiffActions {
  readonly back: () => void;
  /**
   * Ask to discard this file's changes.
   *
   * Only ever *asks*: the confirmation lives with the list, so the sentence
   * about what cannot be undone is written in one place.
   */
  readonly discard?: () => void;
  /** Tick this file for the next commit and go back to the list. */
  readonly include?: () => void;
  /** Already ticked. The button says so and does not tick it twice. */
  readonly included?: boolean;
}

/**
 * The laptop's answer, in the shape this screen draws.
 *
 * One conversion and one only: `null` from the phone's Rust boundary means
 * *this is binary*, and it has to become its own state here rather than an
 * empty body.
 */
export function patchFromOutcome(outcome: FileDiffOutcome): FilePatch {
  if (!outcome.read) {
    if (outcome.code === "unsupported_protocol_version") {
      // Pressing again changes nothing. The thing to do is update that box's
      // hmux, and the screen says exactly that sentence.
      return { kind: "failed", detail: t("이 상자의 hmux가 오래되어 패치를 읽지 못합니다") };
    }
    // `||`, not `??`: an empty string is not a reason either, and `??` would
    // draw a blank line in the one case this fallback exists for.
    return { kind: "failed", detail: outcome.detail || t("노트북이 이유를 말하지 않았습니다") };
  }
  if (outcome.binary) return { kind: "binary" };
  if (outcome.patch === null) {
    // Read, not binary, and no body. Nobody can say what changed, and saying
    // so beats an empty screen that reads as a failed load.
    return { kind: "failed", detail: t("노트북이 본문 없이 답했습니다") };
  }
  return {
    kind: "read",
    patch: outcome.patch,
    truncated: outcome.truncated,
    ...(outcome.added === null ? {} : { added: outcome.added }),
    ...(outcome.deleted === null ? {} : { deleted: outcome.deleted }),
  };
}

/** The last path segment. The header has room for a name, not a path. */
function fileName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** The glass header: back, the file's name, and its ± under it. */
function header(model: FileDiffModel, actions: FileDiffActions): HTMLElement {
  const bar = element("header", "session__header session__header--center");

  const back = element("button", "icon-tap");
  back.type = "button";
  back.setAttribute("aria-label", t("뒤로"));
  back.append(glyph(iconChevronLeft, 20));
  back.addEventListener("click", actions.back);
  bar.append(back);

  const text = element("div", "session__heading diff__heading");
  text.append(element("h1", "session__title", fileName(model.path)));
  const patch = model.patch;
  if (patch.kind === "read" && (patch.added !== undefined || patch.deleted !== undefined)) {
    const counts = element("p", "diff__counts");
    // Absent counts stay absent. `+0 −0` reads as "unchanged" for a file that
    // is on this screen precisely because it changed.
    if (patch.added !== undefined) {
      counts.append(element("span", "diff__added", `+${patch.added}`));
    }
    if (patch.deleted !== undefined) {
      counts.append(element("span", "diff__deleted", `−${patch.deleted}`));
    }
    text.append(counts);
  } else if (model.commit !== undefined) {
    text.append(element("p", "diff__counts", model.commit));
  }
  bar.append(text);
  // The mockup centres the title, which needs a counterweight for the back
  // button. An empty box rather than a second control: there is nothing on the
  // right of this screen to press.
  bar.append(element("div", "session__icons"));
  return bar;
}

/** One line of the file. */
function diffRow(row: DiffRow): HTMLElement {
  if (row.kind === "hunk") {
    const node = element("div", "diff__row diff__row--hunk");
    node.append(element("span", "diff__gutter"));
    node.append(element("span", "diff__text", row.text));
    return node;
  }
  if (row.kind === "note") {
    const node = element("div", "diff__row diff__row--note");
    node.append(element("span", "diff__gutter"));
    node.append(element("span", "diff__text", row.text));
    return node;
  }
  const node = element("div", `diff__row diff__row--${row.kind}`);
  node.append(element("span", "diff__gutter", row.line === undefined ? "" : String(row.line)));
  const text = element("span", "diff__text");
  // The sign is drawn, not implied by colour alone: colour is the only thing
  // separating an addition from a deletion otherwise, and that is exactly the
  // distinction a person with a colour vision deficiency cannot make.
  text.append(element("span", "diff__sign", row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "));
  text.append(element("span", "diff__body", row.text));
  node.append(text);
  return node;
}

function body(model: FileDiffModel): HTMLElement {
  const patch = model.patch;
  if (patch.kind === "loading") {
    const box = element("div", "scm__pending");
    box.append(loader(16));
    box.append(element("p", "scm__pending-title", t("변경 내용을 읽는 중")));
    return box;
  }
  if (patch.kind === "failed") {
    const box = element("div", "scm__pending");
    box.append(element("p", "scm__pending-title", t("변경 내용을 읽지 못했습니다")));
    // The answering side's own sentence, not a rewrite of it.
    box.append(element("p", "scm__pending-note", patch.detail));
    return box;
  }
  if (patch.kind === "binary") {
    const box = element("div", "scm__pending");
    box.append(element("p", "scm__pending-title", t("이진 파일입니다")));
    box.append(element("p", "scm__pending-note", t("줄 단위로 보여 줄 내용이 없습니다")));
    return box;
  }
  const parsed = parseUnifiedDiff(patch.patch);
  if (parsed.rows.length === 0) {
    const box = element("div", "scm__pending");
    // Two different facts, and they send a person to different places: a
    // rename with no edits, versus a file whose content genuinely matches.
    box.append(
      element(
        "p",
        "scm__pending-title",
        parsed.hunked ? t("바뀐 줄이 없습니다") : t("파일 내용은 그대로입니다"),
      ),
    );
    if (!parsed.hunked) {
      box.append(element("p", "scm__pending-note", t("이름이나 권한만 바뀌었습니다")));
    }
    return box;
  }
  const list = element("div", "diff");
  for (const row of parsed.rows) list.append(diffRow(row));
  if (patch.truncated) {
    // Said, never silent. Without this the screen claims the file ends here.
    const cut = element("p", "diff__truncated", t("이 아래는 너무 길어 잘렸습니다"));
    list.append(cut);
  }
  return list;
}

export function renderFileDiff(
  model: FileDiffModel,
  actions: FileDiffActions,
): HTMLElement {
  const screen = element("div", "session scm");
  screen.append(header(model, actions));
  const host = element("div", "scm__body");
  host.append(body(model));
  screen.append(host);

  // 두 버튼은 실제로 할 수 있을 때만 선다. 커밋된 파일에는 버릴 것도 넣을 것도
  // 없고, 짝지은 노트북이 없는 경로에는 그 명령 자체가 없다.
  if (actions.discard || actions.include) {
    const footer = element("div", "diff__footer");
    if (actions.discard) {
      const revert = element("button", "pair-button pair-button--outline", t("변경 되돌리기"));
      revert.type = "button";
      revert.addEventListener("click", () => actions.discard?.());
      footer.append(revert);
    }
    if (actions.include) {
      const include = element(
        "button",
        "pair-button pair-button--solid",
        actions.included === true ? t("커밋에 포함됨") : t("커밋에 포함"),
      );
      include.type = "button";
      include.disabled = actions.included === true;
      include.addEventListener("click", () => actions.include?.());
      footer.append(include);
    }
    screen.classList.add("scm--docked");
    screen.append(footer);
  }
  return screen;
}
