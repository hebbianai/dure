/**
 * Adding an SSH host by typing its address. Figma 3177:82034, with the
 * unreachable state at 3177:82150.
 *
 * # Why there is no host-key field
 *
 * Every connection this phone makes is pinned to a host key, and the screen
 * this replaces asked the person to type that fingerprint in. Nobody can: it is
 * a hash the host computes, and reading it means being at the host — which is
 * where the phone is not. So the frame asks for the four things a person does
 * know, and the host is asked for its key on save.
 *
 * # Why the failure is a card and not a banner
 *
 * 3177:82150 draws it at the bottom of the form, above 저장, because it is
 * about the thing that was just attempted and the fix is in the fields above
 * it or on the host itself. A banner at the top would sit under the title,
 * where it reads as a fact about the screen rather than about this attempt.
 */

import iconChevronLeft from "./assets/icon-chevron-left.svg";
import iconCircleAlert from "./assets/icon-circle-alert.svg";
import iconKey from "./assets/icon-key.svg";
import { element, glyph } from "./dom";
import { t } from "./i18n";
import {
  DEFAULT_SSH_PORT,
  type SshHostAuth,
  type SshHostForm,
  sshHostFormComplete,
} from "./sshHostDraft";
import "./sshHostAddView.css";

export interface SshHostAddModel {
  readonly form: SshHostForm;
  /** The dial is out. 저장 must not go twice — the second one adds a twin. */
  readonly saving?: boolean;
  /** Why the last attempt did not reach the host, in the frame's two lines. */
  readonly failure?: { readonly title: string; readonly detail: string };
}

export interface SshHostAddActions {
  readonly back: () => void;
  /**
   * Opens the system file picker and reads what was chosen, or nothing if the
   * person backed out. The app owns this because it is the one call that
   * reaches outside the webview.
   */
  readonly importKey: () => Promise<
    { readonly privateKeyPem: string; readonly fileName: string } | undefined
  >;
  /**
   * Remembers what has been typed — without redrawing.
   *
   * The fields are the state while this screen is up, and a render between two
   * keystrokes replaces the field being typed into, which takes the caret and
   * the OS keyboard with it. So the tree is the authority here and this is the
   * copy kept for the renders that come from elsewhere.
   */
  readonly edit: (form: SshHostForm) => void;
  readonly save: (form: SshHostForm) => void;
}

/** The four typed fields. `auth` is chosen, not typed. */
type Field = Exclude<keyof SshHostForm, "auth">;

function field(
  label: string,
  name: Field,
  form: SshHostForm,
  options: {
    readonly placeholder: string;
    readonly numeric?: boolean;
    readonly typed: (value: string) => void;
  },
): HTMLElement {
  const stack = element("label", "ssh-add__field");
  stack.append(element("span", "ssh-add__label", t(label)));
  const input = element("input", "ssh-add__input");
  input.value = form[name];
  input.placeholder = options.placeholder;
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.setAttribute("autocorrect", "off");
  input.spellcheck = false;
  if (options.numeric) input.inputMode = "numeric";
  // Per keystroke rather than on blur: 저장 lights up the moment the form is
  // complete, and the frame's disabled button is the only thing that says what
  // is still missing.
  input.addEventListener("input", () => options.typed(input.value));
  stack.append(input);
  return stack;
}

/** The row 3177:82062 draws: which key, and where it came from. */
function keyRow(name: string, origin: string): HTMLElement {
  const row = element("div", "ssh-add__key");
  row.append(glyph(iconKey, 16, "ssh-add__key-icon"));
  const meta = element("div", "ssh-add__key-meta");
  const title = element("p", "ssh-add__key-name");
  title.append(document.createTextNode(`${name} `));
  title.append(element("span", "ssh-add__key-origin", origin));
  meta.append(title, element("p", "ssh-add__key-type", "ED25519"));
  row.append(meta);
  return row;
}

const AUTH_CHOICES = [
  { kind: "device", label: "이 기기 키" },
  { kind: "password", label: "비밀번호" },
  { kind: "imported", label: "키 가져오기" },
] as const;

/**
 * How to get in, and what each way still needs.
 *
 * The three are one row of choices and one thing under it, because they are
 * the same decision seen three ways — not three sections a person reads past.
 * What sits under the row is only ever about the way that is chosen.
 */
function authSection(
  auth: SshHostAuth,
  actions: {
    readonly choose: (kind: (typeof AUTH_CHOICES)[number]["kind"]) => void;
    readonly password: (value: string) => void;
    readonly importKey: () => void;
  },
): HTMLElement {
  const stack = element("div", "ssh-add__field ssh-add__auth");
  stack.append(element("span", "ssh-add__label", t("인증")));
  const choices = element("div", "ssh-add__choices");
  choices.setAttribute("role", "radiogroup");
  choices.setAttribute("aria-label", t("인증"));
  for (const choice of AUTH_CHOICES) {
    const button = element("button", `ssh-add__choice ssh-add__choice--${choice.kind}`);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(auth.kind === choice.kind));
    button.textContent = t(choice.label);
    if (auth.kind === choice.kind) button.classList.add("ssh-add__choice--on");
    button.addEventListener("click", () => actions.choose(choice.kind));
    choices.append(button);
  }
  stack.append(choices);

  if (auth.kind === "device") {
    stack.append(keyRow("dure-key", t("· 이 기기에서 생성됨")));
    stack.append(
      element(
        "p",
        "ssh-add__note",
        t(
          "저장하면 이 기기의 공개 키를 보여 드립니다. 호스트 ~/.ssh/authorized_keys에 추가하세요. 비밀번호 인증은 지원하지 않습니다.",
        ),
      ),
    );
    return stack;
  }

  if (auth.kind === "imported") {
    const pick = element("button", "ssh-add__pick");
    pick.type = "button";
    pick.textContent = auth.fileName.length > 0 ? auth.fileName : t("키 파일 선택");
    pick.addEventListener("click", actions.importKey);
    stack.append(pick);
    if (auth.privateKeyPem.trim().length > 0) {
      stack.append(keyRow(auth.fileName, t("· 가져온 키")));
    }
    stack.append(
      element("p", "ssh-add__note", t("이 호스트가 이미 아는 개인키를 고르세요.")),
    );
    return stack;
  }

  const password = element("input", "ssh-add__input");
  password.type = "password";
  password.value = auth.password;
  password.placeholder = t("비밀번호");
  password.autocapitalize = "off";
  password.autocomplete = "current-password";
  password.addEventListener("input", () => actions.password(password.value));
  stack.append(password);
  stack.append(
    element(
      "p",
      "ssh-add__note",
      t("비밀번호는 이 기기의 키를 호스트에 등록할 때 한 번만 쓰고 저장하지 않습니다."),
    ),
  );
  return stack;
}

/** 3177:82150's card: what failed, and where to look. */
function failureCard(failure: NonNullable<SshHostAddModel["failure"]>): HTMLElement {
  const card = element("div", "ssh-add__failure");
  card.setAttribute("role", "status");
  card.append(glyph(iconCircleAlert, 16, "ssh-add__failure-icon"));
  const lines = element("div", "ssh-add__failure-lines");
  lines.append(
    element("p", "ssh-add__failure-title", failure.title),
    element("p", "ssh-add__failure-detail", failure.detail),
  );
  card.append(lines);
  return card;
}

export function renderSshHostAddScreen(
  model: SshHostAddModel,
  actions: SshHostAddActions,
): HTMLElement {
  const screen = element("section", "pair-screen ssh-add");
  const bar = element("header", "pair-bar ssh-add__bar");
  const back = element("button", "icon-tap");
  back.type = "button";
  back.setAttribute("aria-label", t("뒤로"));
  back.append(glyph(iconChevronLeft, 20));
  back.addEventListener("click", actions.back);
  bar.append(back, element("h1", "pair-bar__title", t("SSH 호스트 추가")));
  screen.append(bar);

  // The typed values live here for as long as the screen does. `model.form` is
  // where they came from — a screen redrawn from elsewhere starts where the
  // person left off.
  let typed: SshHostForm = model.form;

  const body = element("div", "ssh-add__body");
  const form = element("div", "ssh-add__form");
  // Host and port share a row: the port is a narrow field beside the address it
  // belongs to, not a line of its own (3177:82042).
  const address = element("div", "ssh-add__address");
  const on = <K extends keyof SshHostForm>(name: K) => (value: SshHostForm[K]) => {
    typed = { ...typed, [name]: value };
    actions.edit(typed);
    save.disabled = !sshHostFormComplete(typed);
    // The card was about the address as it stood, and that is exactly what is
    // being changed. Removed here rather than through a render, for the reason
    // `edit` does not render either.
    body.querySelector(".ssh-add__failure")?.remove();
  };
  address.append(
    field("호스트", "host", typed, { placeholder: "100.64.0.1", typed: on("host") }),
    field("포트", "port", typed, {
      placeholder: String(DEFAULT_SSH_PORT),
      numeric: true,
      typed: on("port"),
    }),
  );
  address.lastElementChild?.classList.add("ssh-add__field--port");
  form.append(address);
  form.append(
    field("사용자", "username", typed, {
      placeholder: t("User name"),
      typed: on("username"),
    }),
  );
  form.append(
    field("라벨 (선택)", "label", typed, { placeholder: "mac-mini", typed: on("label") }),
  );
  // Rebuilt in place when the choice changes: the fields above it are the
  // authority while this screen is up, and a render would replace them.
  const auth = element("div", "ssh-add__auth-slot");
  const paintAuth = (): void => {
    auth.replaceChildren(
      authSection(typed.auth, {
        choose: (kind) => {
          if (typed.auth.kind === kind) return;
          on("auth")(
            kind === "device"
              ? { kind: "device" }
              : kind === "password"
                ? { kind: "password", password: "" }
                : { kind: "imported", privateKeyPem: "", fileName: "" },
          );
          paintAuth();
        },
        password: (password) => on("auth")({ kind: "password", password }),
        importKey: () => void actions.importKey().then((picked) => {
          if (!picked) return;
          on("auth")({ kind: "imported", ...picked });
          paintAuth();
        }),
      }),
    );
  };
  paintAuth();
  form.append(auth);
  body.append(form);
  if (model.failure) body.append(failureCard(model.failure));
  screen.append(body);

  const footer = element("div", "ssh-add__footer");
  const save = element(
    "button",
    "ssh-add__save",
    model.saving ? t("연결 중…") : t("저장"),
  );
  save.type = "button";
  // Incomplete or already dialing: the frame draws the button at half opacity
  // in the first state (3177:82073), and a second dial would add a twin.
  save.disabled = model.saving === true || !sshHostFormComplete(typed);
  save.addEventListener("click", () => actions.save(typed));
  footer.append(save);
  screen.append(footer);
  return screen;
}
