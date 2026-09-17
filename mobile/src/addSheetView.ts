/**
 * 추가 — the sheet the home screen's "+" opens. Figma `dure-UI` 3096:86354.
 *
 * # Why a sheet and not a screen
 *
 * It is about the list underneath it. The scrim keeps that list visible on
 * purpose: what is being added is added to *those* computers, and a full screen
 * would take the context away at the moment it answers "add to what".
 *
 * # Why the two rows are not new capability
 *
 * Both already existed and both were hard to find. 새 에이전트 was what the FAB
 * did directly, with no way to know that was what it did; SSH 호스트 추가 was
 * one tap inside 설정. The sheet's only claim is that the two belong in the same
 * place, because "add" is one question with two answers.
 *
 * Draws only — where each row leads is `app.ts`'s to say.
 */

import iconChevronRight from "./assets/icon-chevron-right.svg";
import iconLayers from "./assets/icon-layers.svg";
import iconServer from "./assets/icon-server.svg";
import { element, glyph, sheetShell } from "./dom";
import { t } from "./i18n";

export interface AddSheetActions {
  readonly dismiss: () => void;
  /** Ask a paired computer to start an agent in a folder it knows. */
  readonly startAgent: () => void;
  /** Open the form for a new SSH connection. */
  readonly addHost: () => void;
}

export function renderAddSheet(actions: AddSheetActions): HTMLElement {
  const { host, panel } = sheetShell(t("추가"), actions.dismiss, "sheet--tray sheet--add");

  const rows = element("div", "add-sheet__rows");
  rows.append(
    addRow(
      iconLayers,
      t("새 에이전트"),
      t("등록된 폴더에서 에이전트를 시작합니다"),
      actions.startAgent,
    ),
    addRow(
      iconServer,
      t("SSH 호스트 추가"),
      t("호스트명·사용자·키로 새 연결을 만듭니다"),
      actions.addHost,
    ),
  );
  panel.append(rows);
  return host;
}

/**
 * One row: a marked tile, what it is, what it does, and a chevron.
 *
 * The note is not decoration. "새 에이전트" alone does not say where the agent
 * would appear, and the two rows are otherwise close enough in shape that
 * somebody would have to press one to find out which is which.
 */
function addRow(icon: string, name: string, note: string, onPress: () => void): HTMLElement {
  const row = element("button", "add-sheet__row");
  row.type = "button";

  const lead = element("div", "add-sheet__lead");
  const mark = element("span", "add-sheet__mark");
  mark.append(glyph(icon, 18));
  const text = element("div", "add-sheet__text");
  text.append(element("span", "add-sheet__name", name), element("span", "add-sheet__note", note));
  lead.append(mark, text);

  row.append(lead, glyph(iconChevronRight, 16, "add-sheet__chevron"));
  row.addEventListener("click", onPress);
  return row;
}
