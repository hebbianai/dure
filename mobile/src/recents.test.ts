import { describe, expect, it } from "vitest";
import { forServers, load, save, withVisit, type RecentVisit } from "./recents";

function visit(overrides: Partial<RecentVisit> = {}): RecentVisit {
  return {
    serverId: "gate1",
    serverLabel: "Gate1",
    sessionId: "standalone_aaa",
    title: "feat/mobile-page",
    visitedAtUnixMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** 던지지 않는 최소 저장소. Safari 사생활 모드 흉내는 별도 테스트에서. */
function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    read: () => value,
  };
}

describe("withVisit", () => {
  it("가장 최근이 맨 앞에 온다", () => {
    const list = withVisit([visit({ sessionId: "old" })], visit({ sessionId: "new" }));
    expect(list.map((entry) => entry.sessionId)).toEqual(["new", "old"]);
  });

  it("같은 세션을 다시 봐도 줄이 늘지 않는다", () => {
    const first = withVisit([], visit({ visitedAtUnixMs: 1 }));
    const second = withVisit(first, visit({ visitedAtUnixMs: 2 }));

    expect(second.length).toBe(1);
    expect(second[0]?.visitedAtUnixMs).toBe(2);
  });

  /**
   * 세션 id는 서버 안에서만 유일하다. 서버 id를 키에 넣지 않으면 두 서버가 같은
   * id를 가진 순간 한 줄이 다른 줄을 지우고, 재개는 엉뚱한 기계로 붙는다.
   */
  it("서버가 다르면 같은 세션 id도 다른 줄이다", () => {
    const list = withVisit(
      [visit({ serverId: "gate1", sessionId: "same" })],
      visit({ serverId: "clink", sessionId: "same" }),
    );

    expect(list.length).toBe(2);
  });

  it("무한히 쌓이지 않는다", () => {
    let list: RecentVisit[] = [];
    for (let index = 0; index < 30; index += 1) {
      list = withVisit(list, visit({ sessionId: `session-${index}` }));
    }
    expect(list.length).toBe(8);
    expect(list[0]?.sessionId).toBe("session-29");
  });
});

describe("forServers", () => {
  it("페어링이 해제된 서버의 방문은 사라진다", () => {
    const list = forServers(
      [visit({ serverId: "gate1" }), visit({ serverId: "gone", sessionId: "b" })],
      ["gate1"],
    );

    expect(list.map((entry) => entry.serverId)).toEqual(["gate1"]);
  });
});

describe("load", () => {
  it("저장한 것을 그대로 읽는다", () => {
    const storage = memoryStorage();
    save([visit()], storage);

    expect(load(storage)).toEqual([visit()]);
  });

  it("저장소가 비어 있으면 빈 목록이다", () => {
    expect(load(memoryStorage())).toEqual([]);
  });

  /**
   * 홈 화면이 뜨지 않는 것보다 재개 줄이 비어 있는 게 낫다. 깨진 JSON은
   * 편의 기능 하나를 잃게 할 뿐이고, 화면 전체를 막아서는 안 된다.
   */
  it("깨진 저장소가 화면을 막지 않는다", () => {
    expect(load(memoryStorage("{ not json"))).toEqual([]);
    expect(load(memoryStorage('"문자열"'))).toEqual([]);
    expect(load(memoryStorage("null"))).toEqual([]);
  });

  /**
   * 저장소에서 온 값은 우리 타입이 아니라 남의 JSON이다. 검증하지 않으면
   * `undefined`가 제목으로 렌더된다.
   */
  it("모양이 다른 항목은 화면까지 흘러가지 않는다", () => {
    const hostile = JSON.stringify([
      { serverId: "gate1" },
      { serverId: "", serverLabel: "", sessionId: "a", title: "", visitedAtUnixMs: 1 },
      { ...visit(), visitedAtUnixMs: "어제" },
      { ...visit(), visitedAtUnixMs: Number.NaN },
      visit({ sessionId: "good" }),
    ]);

    expect(load(memoryStorage(hostile))).toEqual([visit({ sessionId: "good" })]);
  });

  it("접근 자체가 막힌 저장소에서도 던지지 않는다", () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError: localStorage is disabled");
      },
    };

    expect(load(blocked)).toEqual([]);
  });
});

describe("save", () => {
  it("저장소가 막혀도 던지지 않는다", () => {
    const full = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };

    expect(() => save([visit()], full)).not.toThrow();
  });
});
