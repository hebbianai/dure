import { describe, expect, it } from "vitest";
import { setLang, t } from "@/lib/i18n";
import {
  authRemediation,
  authState,
  branchNameForWorkItem,
  parseAuthStatus,
  parseWorkItemRef,
  parseWorkItems,
  type GhAccount,
  type GhAuthState,
} from "./gh";

const KEYRING_STATUS = `github.com
  ✓ Logged in to github.com account kattpish (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token scopes: 'gist', 'read:org', 'repo'
`;

const ENV_STATUS = `github.com
  ✓ Logged in to github.com account ci-bot (GITHUB_TOKEN)
  - Active account: true
  - Token scopes: 'repo'
`;

describe("parseAuthStatus", () => {
  it("keyring 계정의 호스트·사용자·스코프를 읽는다", () => {
    expect(parseAuthStatus(KEYRING_STATUS)).toEqual([
      {
        host: "github.com",
        user: "kattpish",
        active: true,
        source: "keyring",
        envToken: null,
        scopes: ["gist", "read:org", "repo"],
      },
    ]);
  });

  it("env 토큰이 덮고 있으면 source를 env로 구분한다", () => {
    const [account] = parseAuthStatus(ENV_STATUS);
    expect(account.source).toBe("env");
    expect(account.envToken).toBe("GITHUB_TOKEN");
  });

  it("여러 호스트를 각각 읽는다 — GHES가 섞여도 하나로 뭉개지 않는다", () => {
    const accounts = parseAuthStatus(`${KEYRING_STATUS}
ghe.internal
  ✓ Logged in to ghe.internal account worker (keyring)
  - Active account: false
  - Token scopes: 'repo'
`);
    expect(accounts.map((a) => a.host)).toEqual(["github.com", "ghe.internal"]);
    expect(accounts[1].active).toBe(false);
  });

  it("빈 출력은 빈 목록 — 파싱 실패가 예외로 번지지 않는다", () => {
    expect(parseAuthStatus("")).toEqual([]);
  });
});

describe("authState", () => {
  const account = (over: Partial<GhAccount> = {}): GhAccount => ({
    host: "github.com",
    user: "u",
    active: true,
    source: "keyring",
    envToken: null,
    scopes: ["repo", "read:org"],
    ...over,
  });

  it("gh가 없으면 미인증과 구분한다", () => {
    expect(authState([], true)).toEqual({ kind: "missing" });
  });

  it("계정이 없으면 로그아웃", () => {
    expect(authState([], false)).toEqual({ kind: "logged-out" });
  });

  it("필요한 스코프가 다 있으면 ready", () => {
    expect(authState([account()], false).kind).toBe("ready");
  });

  it("스코프가 모자라면 무엇이 없는지 알려준다", () => {
    const state = authState([account({ scopes: ["repo"] })], false);
    expect(state).toMatchObject({ kind: "missing-scopes", missing: ["read:org"] });
  });

  /** 이 케이스가 이 모듈의 존재 이유다 — 안내대로 해도 아무 일이 안 일어난다. */
  it("env 토큰이 덮고 있으면 missing-scopes가 아니라 env-shadowed다", () => {
    const state = authState(
      [account({ scopes: ["repo"], source: "env", envToken: "GH_TOKEN" })],
      false,
    );
    expect(state.kind).toBe("env-shadowed");
    // 같은 상황을 missing-scopes로 판정하면 `gh auth refresh`를 안내하게 되고,
    // 그 명령은 env 토큰 앞에서 조용히 no-op이라 사용자가 계속 막힌다.
    const remediation = authRemediation(state);
    const rendered = t(remediation?.key ?? "", remediation?.params);
    expect(rendered).toContain("GH_TOKEN");
    expect(rendered).not.toContain("gh auth refresh -s");
  });

  it("active 계정이 없으면 첫 계정으로 판정한다", () => {
    const state = authState([account({ active: false })], false);
    expect(state.kind).toBe("ready");
  });
});

describe("parseWorkItemRef", () => {
  it("#번호, 번호, 이슈/PR URL을 모두 받는다", () => {
    expect(parseWorkItemRef("#1234")).toBe(1234);
    expect(parseWorkItemRef("1234")).toBe(1234);
    expect(parseWorkItemRef("https://github.com/o/r/issues/77")).toBe(77);
    expect(parseWorkItemRef("https://github.com/o/r/pull/88")).toBe(88);
  });

  it("번호가 아니면 null", () => {
    expect(parseWorkItemRef("")).toBeNull();
    expect(parseWorkItemRef("feature/login")).toBeNull();
  });
});

describe("parseWorkItems", () => {
  it("json 배열을 항목으로 읽는다", () => {
    const items = parseWorkItems(
      '[{"number":12,"title":"Fix retry"},{"number":13,"title":"B"}]',
      "issue",
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ number: 12, title: "Fix retry", kind: "issue" });
  });

  it("깨진 JSON은 빈 목록 — 조회 실패가 다이얼로그를 죽이면 안 된다", () => {
    expect(parseWorkItems("not json", "issue")).toEqual([]);
    expect(parseWorkItems('{"number":1}', "issue")).toEqual([]);
  });

  it("number가 없는 항목은 버린다", () => {
    expect(parseWorkItems('[{"title":"no number"}]', "issue")).toEqual([]);
  });
});

describe("branchNameForWorkItem", () => {
  it("이슈는 번호+슬러그로 만든다", () => {
    expect(
      branchNameForWorkItem({ number: 1234, title: "Fix retry logic", kind: "issue" }),
    ).toBe("issue-1234-fix-retry-logic");
  });

  it("PR은 head 브랜치를 그대로 쓴다 — 새로 만들면 그 PR을 이어받지 못한다", () => {
    expect(
      branchNameForWorkItem({
        number: 9,
        title: "Anything",
        kind: "pr",
        headRefName: "feature/login",
      }),
    ).toBe("feature/login");
  });

  it("제목이 슬러그로 남지 않으면 번호만 쓴다", () => {
    expect(branchNameForWorkItem({ number: 5, title: "!!!", kind: "issue" })).toBe(
      "issue-5",
    );
  });

  it("긴 제목은 잘리고 끝의 하이픈이 남지 않는다", () => {
    const name = branchNameForWorkItem(
      { number: 7, title: "a".repeat(80), kind: "issue" },
      10,
    );
    expect(name).toBe("issue-7-aaaaaaaaaa");
    expect(name.endsWith("-")).toBe(false);
  });
});

describe("authRemediation 번역 키", () => {
  const account = (over: Partial<GhAccount> = {}): GhAccount => ({
    host: "github.com",
    user: "u",
    active: true,
    source: "keyring",
    envToken: null,
    scopes: [],
    ...over,
  });

  /** authRemediation resolves its semantic IDs through t() at call time.
   *  The default display language is English, so a missing en entry would
   *  leak Korean into the default UI — resolve under "en" and require the
   *  output to be Hangul-free. */
  it("영어 표시 언어에서 모든 복구 안내가 영어로 해석된다", () => {
    const states: GhAuthState[] = [
      { kind: "missing" },
      { kind: "logged-out" },
      { kind: "missing-scopes", account: account(), missing: ["repo"] },
      {
        kind: "env-shadowed",
        account: account({ source: "env", envToken: "GH_TOKEN" }),
        missing: ["repo"],
      },
    ];
    setLang("en");
    try {
      for (const state of states) {
        const key = authRemediation(state)?.key;
        expect(key, `${state.kind}의 키가 등록되지 않았다`).toBeDefined();
        expect(key, `en에서 한국어가 새어 나옴: ${key}`).not.toMatch(/[가-힣]/);
      }
    } finally {
      setLang("ko");
    }
  });

  it("보간 자리표시자가 값으로 채워진다 — {scopes}가 그대로 보이면 안 된다", () => {
    const state: GhAuthState = {
      kind: "missing-scopes",
      account: account(),
      missing: ["repo", "read:org"],
    };
    const remediation = authRemediation(state);
    const rendered = t(remediation?.key ?? "", remediation?.params);
    expect(rendered).toContain("repo,read:org");
    expect(rendered).not.toContain("{scopes}");
  });
});
