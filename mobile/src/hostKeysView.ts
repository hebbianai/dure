/**
 * 설정 › 호스트 › SSH 키 — one host's public key and its private slots.
 *
 * The public key is drawn verbatim in a selectable `<pre>`: it is read against
 * a file on another machine, a shortened line can never be pasted, and the
 * selectable block is the fallback that still works when the clipboard says
 * no. The private slots record every keystroke through `editDraft` and never
 * redraw on it — the host check the detail screen fired can land while
 * someone is pasting, and a redraw that rebuilt a textarea nobody recorded
 * would take the paste with it.
 */

import { element } from "./dom";
import { type HostKeysModel, canSave } from "./hostKeys";
import { renderHostSettingsHeader } from "./hostSettingsView";
import { t } from "./i18n";
import type { KeyRole } from "./ipc";
import "./hostKeysView.css";

export type { HostKeysModel } from "./hostKeys";

export interface HostKeysActions {
  readonly back: () => void;
  readonly copyPublicKey: () => void;
  readonly pickFile: (role: KeyRole) => void;
  readonly editDraft: (role: KeyRole, text: string) => void;
  readonly save: (role: KeyRole) => void;
}

const SLOTS: readonly { role: KeyRole; title: string; hint: string }[] = [
  {
    role: "attach",
    title: "연결용 SSH 개인키",
    hint: 'authorized_keys에 `command="hmux mobile-gateway",restrict`로 고정하는 키입니다 — 그 계정의 모든 세션에 닿습니다',
  },
  {
    role: "list",
    title: "목록 조회용 SSH 개인키 (선택)",
    hint: "목록 조회는 이제 스트림 요청으로 하므로 별도 키가 필요 없습니다. 손으로 --list를 고정해 둔 서버에만 쓰세요. 비워 두면 연결용 키를 그대로 씁니다.",
  },
];

function publicKeySection(model: HostKeysModel, actions: HostKeysActions): HTMLElement {
  const section = element("section", "host-keys__section");
  section.append(element("h2", "host-keys__label", t("공개 키")));

  if (model.publicKey !== undefined) {
    const line = element("pre", "host-keys__public-key", model.publicKey);
    section.append(line);
  } else if (model.publicKeyFailure !== undefined) {
    section.append(
      element("p", "banner banner--warn host-keys__public-key-failure", model.publicKeyFailure),
    );
  } else {
    section.append(element("p", "host-keys__pending", t("확인 중")));
  }

  section.append(
    element(
      "p",
      "host-keys__hint",
      t("호스트가 이 키를 신뢰해야 연결됩니다. ~/.ssh/authorized_keys에 이 줄이 있어야 합니다."),
    ),
  );

  const copy = element("button", "host-keys__copy", t(model.copied ? "복사됨" : "복사"));
  copy.type = "button";
  copy.disabled = model.publicKey === undefined;
  copy.addEventListener("click", actions.copyPublicKey);
  section.append(copy);
  return section;
}

function slotSection(
  slot: (typeof SLOTS)[number],
  model: HostKeysModel,
  actions: HostKeysActions,
): HTMLElement {
  const section = element("section", "host-keys__section host-keys__slot");
  section.append(element("h2", "host-keys__label", t(slot.title)));
  section.append(
    element(
      "p",
      "host-keys__stored",
      model.stored[slot.role] ? t("등록됨 — 새로 붙여넣으면 대체됩니다") : t("등록되지 않음"),
    ),
  );
  section.append(element("p", "host-keys__hint", t(slot.hint)));

  const area = element("textarea", "host-keys__textarea");
  area.rows = 4;
  area.placeholder = "-----BEGIN OPENSSH PRIVATE KEY-----";
  area.autocapitalize = "off";
  area.spellcheck = false;
  area.value = model.drafts[slot.role];

  const controls = element("div", "host-keys__controls");
  const pick = element("button", "host-keys__pick", t("키 파일 선택"));
  pick.type = "button";
  pick.addEventListener("click", () => actions.pickFile(slot.role));
  const save = element("button", "host-keys__save", t("키 저장"));
  save.type = "button";
  save.disabled = !canSave(area.value);
  save.addEventListener("click", () => actions.save(slot.role));
  controls.append(pick, save);

  // Recorded, not rendered: the button wakes from the textarea it sits under,
  // and the draft goes to state so a redraw nobody asked for restores it.
  area.addEventListener("input", () => {
    save.disabled = !canSave(area.value);
    actions.editDraft(slot.role, area.value);
  });

  section.append(area, controls);
  return section;
}

export function renderHostKeysScreen(
  model: HostKeysModel,
  actions: HostKeysActions,
): HTMLElement {
  const screen = element("section", "pair-screen settings host-settings host-keys");
  screen.append(renderHostSettingsHeader(actions.back, undefined, "SSH 키"));

  const body = element("div", "host-settings__body host-settings__body--detail host-keys__body");
  body.append(element("p", "host-keys__host", model.label));
  body.append(publicKeySection(model, actions));

  // 화면에 붙여 두는 경고. 하드웨어 보관인 척하지 않는 것이 이 화면의 요점이다.
  body.append(
    element(
      "p",
      "banner banner--warn host-keys__warning",
      t("개인키는 앱 저장소에 평문 파일로 저장됩니다. Secure Enclave/Keystore가 아닙니다."),
    ),
  );
  if (model.paired) {
    body.append(
      element(
        "p",
        "host-keys__hint host-keys__paired-hint",
        t(
          "이 서버의 키는 페어링 때 이 기기에서 만들어졌습니다. 여기서 덮어쓰면 서버에 등록된 키와 어긋납니다.",
        ),
      ),
    );
  }
  for (const slot of SLOTS) body.append(slotSection(slot, model, actions));

  screen.append(body);
  return screen;
}
