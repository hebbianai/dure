import { describe, expect, it } from "vitest";
import {
  CONFINEMENT_ACCOUNT_WIDE,
  CONFINEMENT_FORCED_COMMAND,
  type ServerDraft,
  type ServerEntry,
  confinementNote,
  draftToEntry,
  entryToDraft,
  formatEndpoint,
  sortServers,
} from "./servers";

const id = () => "generated-id";

function draft(overrides: Partial<ServerDraft> = {}): ServerDraft {
  return {
    label: "작업 서버",
    host: "box.example",
    port: "",
    username: "kattpish",
    hostKeyFingerprint: "SHA256:AAAABBBBCCCC",
    ...overrides,
  };
}

function entry(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    id: "a",
    label: "작업 서버",
    host: "box.example",
    port: 22,
    username: "kattpish",
    host_key_fingerprint: "SHA256:AAAABBBBCCCC",
    paired: false,
    attach_key_confinement: "",
    ...overrides,
  };
}

/**
 * 페어링으로 들어온 항목의 키가 서버에서 얼마나 제한되어 있는지.
 *
 * `account_wide`를 조용히 넘기면 화면상 손으로 굳힌 서버와 구별되지 않는다 —
 * 그런데 그 키는 그 계정으로 아무 명령이나 실행할 수 있다.
 */
describe("confinementNote", () => {
  it("손으로 넣은 항목에는 아무 말도 하지 않는다", () => {
    expect(confinementNote(entry())).toBeUndefined();
  });

  it("강제 명령에 고정된 키와 그렇지 않은 키를 다르게 말한다", () => {
    const confined = confinementNote(
      entry({ paired: true, attach_key_confinement: CONFINEMENT_FORCED_COMMAND }),
    );
    const wide = confinementNote(
      entry({ paired: true, attach_key_confinement: CONFINEMENT_ACCOUNT_WIDE }),
    );

    expect(confined).not.toBe(wide);
    expect(wide).toContain("어떤 명령이든");
  });

  it("노트북이 말해주지 않은 경우를 고정된 것으로 읽지 않는다", () => {
    const unknown = confinementNote(entry({ paired: true, attach_key_confinement: "" }));

    expect(unknown).toBeDefined();
    expect(unknown).not.toBe(
      confinementNote(entry({ paired: true, attach_key_confinement: CONFINEMENT_FORCED_COMMAND })),
    );
  });
});

describe("draftToEntry", () => {
  it("빈 포트는 SSH 기본 포트로 채운다", () => {
    const result = draftToEntry(draft({ port: "" }), id);

    expect(result).toEqual({ ok: true, entry: entry({ id: "generated-id" }) });
  });

  // `Number(text) || 22`로 썼다면 "0"이 조용히 22가 된다. 0은 유효한 u16이라
  // Rust 저장소도 통과하고, 오류는 연결 시점까지 미뤄진다.
  it("포트 0은 기본값으로 바뀌지 않고 거부된다", () => {
    const result = draftToEntry(draft({ port: "0" }), id);

    expect(result).toEqual({
      ok: false,
      errors: [{ field: "port", code: "port_zero" }],
    });
  });

  it("숫자가 아닌 포트는 거부된다", () => {
    const result = draftToEntry(draft({ port: "22a" }), id);

    expect(result).toEqual({
      ok: false,
      errors: [{ field: "port", code: "port_not_a_number" }],
    });
  });

  it("u16 범위를 넘는 포트는 거부된다", () => {
    const result = draftToEntry(draft({ port: "70000" }), id);

    expect(result).toEqual({
      ok: false,
      errors: [{ field: "port", code: "port_out_of_range" }],
    });
  });

  it("공백만 있는 필드는 비어 있는 것으로 본다", () => {
    const result = draftToEntry(draft({ label: "   ", username: " " }), id);

    expect(result).toEqual({
      ok: false,
      errors: [
        { field: "label", code: "empty" },
        { field: "username", code: "empty" },
      ],
    });
  });

  it("기존 항목을 편집할 때는 id를 새로 만들지 않는다", () => {
    const result = draftToEntry(draft({ id: "kept" }), () => {
      throw new Error("새 id를 만들면 안 된다");
    });

    expect(result.ok && result.entry.id).toBe("kept");
  });

  // 지문은 호스트가 주는 값이라 이 화면에는 그것을 채울 칸이 없다. 지문 없는
  // 예전 항목의 포트 하나를 고치는 저장이 여기서 막히면 그 항목은 편집도 제거도
  // 어긋나는 상태로 남는다 — 상세 화면이 "연결할 수 없다"를 말하고, 저장은 통과한다.
  it("지문이 없는 항목은 빈 지문 그대로 넘긴다", () => {
    const result = draftToEntry(draft({ hostKeyFingerprint: "" }), id);

    expect(result.ok).toBe(true);
    expect(result.ok && result.entry.host_key_fingerprint).toBe("");
  });

  it("SHA256: 접두사가 없는 지문은 거부된다", () => {
    const result = draftToEntry(draft({ hostKeyFingerprint: "AAAABBBBCCCC" }), id);

    expect(result).toEqual({
      ok: false,
      errors: [{ field: "hostKeyFingerprint", code: "fingerprint_shape" }],
    });
  });

  it("접두사만 있고 본문이 없는 지문도 거부된다", () => {
    const result = draftToEntry(draft({ hostKeyFingerprint: "SHA256:" }), id);

    expect(result).toEqual({
      ok: false,
      errors: [{ field: "hostKeyFingerprint", code: "fingerprint_shape" }],
    });
  });
});

describe("entryToDraft", () => {
  it("기본 포트는 빈 칸으로 되돌린다", () => {
    expect(entryToDraft(entry()).port).toBe("");
  });

  it("기본이 아닌 포트는 숫자를 그대로 채운다", () => {
    expect(entryToDraft(entry({ port: 2222 })).port).toBe("2222");
  });

  // 지문 없이 저장된 버전 1 항목을 편집할 때, 빈 칸이 나와야 사용자가 채운다.
  it("지문이 없는 예전 항목도 그대로 실어 온다", () => {
    expect(entryToDraft(entry({ host_key_fingerprint: "" })).hostKeyFingerprint).toBe("");
  });
});

describe("formatEndpoint", () => {
  it("기본 포트는 감춘다", () => {
    expect(formatEndpoint(entry())).toBe("kattpish@box.example");
  });

  it("기본이 아닌 포트는 보여준다", () => {
    expect(formatEndpoint(entry({ port: 2222 }))).toBe("kattpish@box.example:2222");
  });
});

describe("sortServers", () => {
  it("입력 배열을 바꾸지 않는다", () => {
    const servers = [entry({ id: "b", label: "나" }), entry({ id: "a", label: "가" })];

    sortServers(servers);

    expect(servers.map((server) => server.id)).toEqual(["b", "a"]);
  });

  it("라벨이 같으면 접속 주소로 갈린다", () => {
    const sorted = sortServers([
      entry({ id: "b", label: "같은 이름", host: "b.example" }),
      entry({ id: "a", label: "같은 이름", host: "a.example" }),
    ]);

    expect(sorted.map((server) => server.id)).toEqual(["a", "b"]);
  });
});

describe("confinementNote — 관측이 의도를 이긴다", () => {
  const paired = { ...entry(), paired: true, attach_key_confinement: "forced_command" };

  /**
   * 이게 이 함수에서 가장 중요한 성질이다. 2026-07-29에 Tailscale SSH 호스트에서
   * 이 화면이 "고정되어 있습니다"라고 거짓말을 했다 — 그 서버는 authorized_keys를
   * 아예 열지 않으므로 페어링이 심은 강제 명령이 적용되지 않는다. 페어링 시점의
   * 의도(`attach_key_confinement`)와 서버에서 실제로 일어난 일이 갈릴 수 있고,
   * 화면은 후자를 말해야 한다.
   */
  it("서버에서 적용되지 않았다면 설치 의도와 무관하게 그렇게 말한다", () => {
    const note = confinementNote(paired, false);

    expect(note).toMatch(/적용되지 않았습니다/);
    expect(note).not.toMatch(/고정되어 있습니다/);
  });

  it("서버에서 확인됐으면 확인됐다고 말한다", () => {
    const note = confinementNote(paired, true);

    expect(note).toMatch(/고정되어 있습니다/);
    expect(note).toMatch(/확인/);
  });

  /**
   * 관측이 없을 때 "확인"이라고 말하면, 아직 물어보지도 않은 것을 확인했다고
   * 주장하는 것이다.
   */
  it("관측이 없으면 의도라는 것을 문장이 드러낸다", () => {
    const note = confinementNote(paired, undefined);

    expect(note).toMatch(/아직 서버에서 확인하지 않음/);
  });

  it("페어링되지 않은 서버는 아무 말도 하지 않는다", () => {
    expect(confinementNote({ ...entry(), paired: false }, true)).toBeUndefined();
  });
});
