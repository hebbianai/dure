/**
 * The four pairing screens, checked as what they are: pure DOM.
 *
 * They are here rather than in `app.test.ts` because these facts are about the
 * screens themselves, not about the wiring — what a screen refuses to claim,
 * and what it hands back when a button is pressed. Standing up every Tauri
 * command to assert them would hide the assertion inside the fixture.
 */

import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  renderConfirm,
  renderFirstRun,
  renderPaste,
  renderScan,
} from "./pairingScreens";

const FINGERPRINT = "SHA256:krpKSjgWfSmiaJCRvXm2jSibE95Y4/hDhN2FJDsr3Wk";

function press(host: HTMLElement, selector: string): void {
  const button = host.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`no ${selector} in: ${host.textContent}`);
  button.click();
}

describe("first run", () => {
  it("offers both doors, and each one leads somewhere", () => {
    const taken: string[] = [];
    const host = renderFirstRun({
      scan: () => taken.push("scan"),
      paste: () => taken.push("paste"),
    });

    press(host, ".first-run__scan");
    press(host, ".first-run__paste");

    expect(taken).toEqual(["scan", "paste"]);
  });

  /**
   * An earlier draft of the home screen carried counters — agents started,
   * agent hours, PRs opened — that this app has no backend to count. A screen
   * that renders a plausible number is claiming to have measured something it
   * never asked about, and someone makes a decision on it.
   */
  it("writes down no number it did not count", () => {
    const text = renderFirstRun({ scan: () => {}, paste: () => {} }).textContent ?? "";

    for (const claim of ["시작된", "Agent 시간", "생성된 PR", "Agents started", "PRs opened"]) {
      expect(text).not.toContain(claim);
    }
  });

  it("names the three steps the mockup names", () => {
    const host = renderFirstRun({ scan: () => {}, paste: () => {} });

    expect(host.querySelectorAll(".pair-steps__item")).toHaveLength(3);
    expect(host.textContent ?? "").toContain(t("설정 › 모바일 연결에서 페어링 QR을 만듭니다."));
  });
});

describe("scan", () => {
  it("draws the viewfinder while the camera is behind it", () => {
    const host = renderScan({}, { close: () => {}, paste: () => {} });

    expect(host.querySelector(".scan__frame")).not.toBeNull();
    expect(host.classList.contains("scan--blind")).toBe(false);
  });

  /**
   * A reticle with no camera behind it reads as a broken camera, and the
   * person keeps holding a QR code up to a dead screen instead of taking the
   * paste route this same screen offers.
   */
  it("drops the viewfinder when the camera never opened", () => {
    const host = renderScan(
      { notice: "카메라 권한이 필요합니다" },
      { close: () => {}, paste: () => {} },
    );

    expect(host.querySelector(".scan__frame")).toBeNull();
    expect(host.classList.contains("scan--blind")).toBe(true);
    expect(host.textContent ?? "").toContain(t("카메라 권한이 필요합니다"));
  });

  it("keeps a way out that is not the camera", () => {
    let pasted = false;
    const host = renderScan({}, { close: () => {}, paste: () => (pasted = true) });

    press(host, ".scan__paste");

    expect(pasted).toBe(true);
  });
});

describe("paste", () => {
  it("hands back exactly what was typed", () => {
    let submitted: [string, string] | undefined;
    const host = renderPaste(
      { deviceLabel: "내 폰", payload: "", notice: undefined, busy: false },
      { back: () => {}, submit: (label, payload) => (submitted = [label, payload]) },
    );

    const name = host.querySelector<HTMLInputElement>(".paste__label");
    const payload = host.querySelector<HTMLTextAreaElement>(".paste__payload");
    if (!name || !payload) throw new Error("no fields");
    name.value = "책상 폰";
    payload.value = "hmux-pair:1?a=192.0.2.10&p=47821";
    press(host, ".paste__submit");

    expect(submitted).toEqual(["책상 폰", "hmux-pair:1?a=192.0.2.10&p=47821"]);
  });

  /** The private key never leaves the device, and it is also not in an enclave.
   *  Both facts, on the last screen where pairing can be reconsidered. */
  it("does not hide that the key is stored in the clear", () => {
    const host = renderPaste(
      { deviceLabel: "", payload: "", busy: false },
      { back: () => {}, submit: () => {} },
    );

    expect(host.querySelector(".pair-warning")?.textContent).toContain(
      t("개인키는 이 기기를 떠나지 않지만, 앱 저장소에 평문 파일로 저장됩니다. Secure Enclave/Keystore가 아닙니다."),
    );
  });

  it("cannot be submitted twice while it is working", () => {
    let submits = 0;
    const host = renderPaste(
      { deviceLabel: "", payload: "x", busy: true },
      { back: () => {}, submit: () => (submits += 1) },
    );

    press(host, ".paste__submit");

    expect(submits).toBe(0);
  });
});

describe("confirm", () => {
  const offer = {
    boxLabel: "맥북",
    endpoint: "192.168.0.24:7420",
    reach: t("밖에서도 연결됩니다"),
    fingerprint: FINGERPRINT,
    busy: false,
  };

  /**
   * The mockup shows a shortened sample. The real value is what the phone
   * pins, and showing a prefix would make the compared thing a part of the
   * value — on a path whose only trust anchor is this comparison.
   */
  it("shows the fingerprint whole", () => {
    const host = renderConfirm(offer, { back: () => {}, cancel: () => {}, connect: () => {} });

    expect(host.textContent ?? "").toContain(FINGERPRINT);
  });

  /**
   * The mockup reads "세션 3", but that count only exists after the phone has
   * taken the computer's catalog — which is what the button on this screen
   * authorises. A number here would be the screen counting something it has
   * not yet asked about.
   */
  it("claims no session count before it has connected", () => {
    const host = renderConfirm(offer, { back: () => {}, cancel: () => {}, connect: () => {} });

    expect(host.querySelector(".confirm__sessions")).toBeNull();
  });

  it("shows the count once there is one", () => {
    const host = renderConfirm(
      { ...offer, sessionCount: 3 },
      { back: () => {}, cancel: () => {}, connect: () => {} },
    );

    expect(host.querySelector(".confirm__sessions")?.textContent).toBe(
      t("세션 {count}", { count: 3 }),
    );
  });

  it("connects only when the button says so", () => {
    const taken: string[] = [];
    const host = renderConfirm(offer, {
      back: () => taken.push("back"),
      cancel: () => taken.push("cancel"),
      connect: () => taken.push("connect"),
    });

    press(host, ".confirm__cancel");
    press(host, ".confirm__connect");

    expect(taken).toEqual(["cancel", "connect"]);
  });
});
