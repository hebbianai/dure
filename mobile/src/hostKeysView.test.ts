import { describe, expect, it } from "vitest";
import { EMPTY_HOST_KEYS_DRAFT } from "./hostKeys";
import { type HostKeysActions, type HostKeysModel, renderHostKeysScreen } from "./hostKeysView";
import { t } from "./i18n";

const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxvbmcgZW5vdWdoIHRvIHdyYXAgb24gYSBwaG9uZQ dure-mobile";
const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

const noActions: HostKeysActions = {
  back: () => {},
  copyPublicKey: () => {},
  pickFile: () => {},
  editDraft: () => {},
  save: () => {},
};

function model(overrides: Partial<HostKeysModel> = {}): HostKeysModel {
  return {
    label: "Loopback lab",
    paired: false,
    publicKey: PUBLIC_KEY,
    copied: false,
    drafts: EMPTY_HOST_KEYS_DRAFT,
    stored: { attach: true, list: false },
    ...overrides,
  };
}

const textareas = (screen: HTMLElement) => [
  ...screen.querySelectorAll<HTMLTextAreaElement>("textarea"),
];
const saves = (screen: HTMLElement) => [
  ...screen.querySelectorAll<HTMLButtonElement>(".host-keys__save"),
];

describe("renderHostKeysScreen", () => {
  // The line is read against a file on another machine; a shortened one can
  // never be pasted, and a proportional one is misread character by character.
  it("공개 키 한 줄을 줄이지 않고 그대로 보여 준다", () => {
    const screen = renderHostKeysScreen(model(), noActions);
    const line = screen.querySelector(".host-keys__public-key");
    expect(line?.tagName).toBe("PRE");
    expect(line?.textContent).toBe(PUBLIC_KEY);
    expect(screen.querySelector(".host-keys__copy")?.textContent).toBe(t("복사"));
  });

  it("복사한 뒤에는 단추가 복사됨을 읽는다", () => {
    const screen = renderHostKeysScreen(model({ copied: true }), noActions);
    expect(screen.querySelector(".host-keys__copy")?.textContent).toBe(t("복사됨"));
  });

  it("공개 키를 읽지 못하면 그 이유가 그 자리에 선다", () => {
    const screen = renderHostKeysScreen(
      model({ publicKey: undefined, publicKeyFailure: "identity_missing" }),
      noActions,
    );
    expect(screen.querySelector(".host-keys__public-key")).toBeNull();
    expect(screen.querySelector(".host-keys__public-key-failure")?.textContent).toBe(
      "identity_missing",
    );
    expect(screen.querySelector<HTMLButtonElement>(".host-keys__copy")?.disabled).toBe(true);
  });

  it("평문 저장 경고와 두 개인키 슬롯이 있다", () => {
    const screen = renderHostKeysScreen(model(), noActions);
    expect(screen.querySelector(".banner--warn")?.textContent).toBe(
      t("개인키는 앱 저장소에 평문 파일로 저장됩니다. Secure Enclave/Keystore가 아닙니다."),
    );
    expect(textareas(screen)).toHaveLength(2);
    const status = [...screen.querySelectorAll(".host-keys__stored")].map(
      (node) => node.textContent,
    );
    expect(status).toEqual([t("등록됨 — 새로 붙여넣으면 대체됩니다"), t("등록되지 않음")]);
  });

  it("페어링된 서버에만 덮어쓰기 경고가 붙는다", () => {
    expect(
      renderHostKeysScreen(model({ paired: false }), noActions).querySelector(
        ".host-keys__paired-hint",
      ),
    ).toBeNull();
    expect(
      renderHostKeysScreen(model({ paired: true }), noActions).querySelector(
        ".host-keys__paired-hint",
      ),
    ).not.toBeNull();
  });

  it("빈 슬롯의 키 저장은 죽어 있고, PEM 이 들어오면 산다", () => {
    const empty = renderHostKeysScreen(model(), noActions);
    expect(saves(empty).map((button) => button.disabled)).toEqual([true, true]);

    const filled = renderHostKeysScreen(model({ drafts: { attach: PEM, list: "" } }), noActions);
    expect(textareas(filled)[0]?.value).toBe(PEM);
    expect(saves(filled).map((button) => button.disabled)).toEqual([false, true]);
  });

  it("입력·저장·파일 선택·복사·뒤로가 각자의 행동을 부른다", () => {
    const calls: unknown[] = [];
    const screen = renderHostKeysScreen(model({ drafts: { attach: PEM, list: "" } }), {
      back: () => calls.push("back"),
      copyPublicKey: () => calls.push("copy"),
      pickFile: (role) => calls.push(["pick", role]),
      editDraft: (role, text) => calls.push(["edit", role, text]),
      save: (role) => calls.push(["save", role]),
    });

    const list = textareas(screen)[1];
    if (!list) throw new Error("no list textarea");
    list.value = "-----BEGIN";
    list.dispatchEvent(new Event("input", { bubbles: true }));
    saves(screen)[0]?.click();
    screen.querySelectorAll<HTMLButtonElement>(".host-keys__pick")[1]?.click();
    screen.querySelector<HTMLButtonElement>(".host-keys__copy")?.click();
    screen.querySelector<HTMLButtonElement>(".icon-tap")?.click();

    expect(calls).toEqual([
      ["edit", "list", "-----BEGIN"],
      ["save", "attach"],
      ["pick", "list"],
      "copy",
      "back",
    ]);
  });

  // Typing into a slot must wake its own 키 저장 without a redraw: the
  // drafts are recorded, not rendered, so the button reads the textarea.
  it("붙여넣는 순간 그 슬롯의 키 저장이 산다", () => {
    const screen = renderHostKeysScreen(model(), noActions);
    const attach = textareas(screen)[0];
    if (!attach) throw new Error("no attach textarea");
    attach.value = PEM;
    attach.dispatchEvent(new Event("input", { bubbles: true }));
    expect(saves(screen).map((button) => button.disabled)).toEqual([false, true]);
  });
});
