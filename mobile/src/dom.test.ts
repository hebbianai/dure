import { afterEach, describe, expect, it } from "vitest";
import { paintedBackground, statusDot } from "./dom";
import { DEFAULT_SETTINGS_PREFERENCES, saveSettingsPreferences } from "./settingsPreferences";

describe("localized status announcements", () => {
  afterEach(() => localStorage.clear());

  it("resolves every status in the current language when rendered", () => {
    for (const [language, labels] of [
      ["en", ["Running", "Needs attention", "Blocked", "Exited", "Status unknown"]],
      ["ko", ["실행 중", "주의", "차단됨", "종료됨", "상태를 알 수 없음"]],
      ["en", ["Running", "Needs attention", "Blocked", "Exited", "Status unknown"]],
    ] as const) {
      saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, language });
      expect((["run", "warn", "blocked", "done", "unknown"] as const)
        .map(state => statusDot(state).getAttribute("aria-label"))).toEqual(labels);
    }
  });
});

describe("statusDot", () => {
  it("draws a lifecycle with the shared status mark and never as work", () => {
    const look = (state: Parameters<typeof statusDot>[0]) => {
      const { agentTone, agentFill, agentMotion } = statusDot(state).dataset;
      return [agentTone, agentFill, agentMotion];
    };
    // Green and breathing belong to an agent the desktop reports at work;
    // a session the phone only knows as running rests.
    expect(look("run")).toEqual(["rest", "solid", "still"]);
    expect(look("warn")).toEqual(["neutral", "solid", "pulse"]);
    expect(look("blocked")).toEqual(["danger", "solid", "still"]);
    expect(look("done")).toEqual(["neutral", "hollow", "still"]);
    expect(look("unknown")).toEqual(["neutral", "solid", "still"]);
  });
});

/**
 * 터미널 표면은 자기 배경을 따로 칠하면 안 된다.
 *
 * 호스트에는 이미 시안의 pane 색과 16px 안쪽 여백이 있다. 표면이 다른 색을
 * 칠하면 그 여백에서 두 색이 만나고, **터미널 둘레에 테두리가 그려진 것처럼**
 * 보인다. 그래서 색의 주인은 스타일시트 하나이고, 표면은 받은 노드에 묻는다.
 */
describe("paintedBackground", () => {
  it("칠해져 있으면 그 색을 준다", () => {
    const node = document.createElement("div");
    node.style.background = "rgb(36, 36, 36)";
    document.body.append(node);

    expect(paintedBackground(node)).toBe("rgb(36, 36, 36)");

    node.remove();
  });

  it("칠해져 있지 않으면 아무것도 주지 않는다", () => {
    const node = document.createElement("div");
    document.body.append(node);

    // 투명한 노드를 색으로 읽으면 표면이 검정 위에 검정을 칠하게 된다.
    expect(paintedBackground(node)).toBeUndefined();

    node.remove();
  });
});
