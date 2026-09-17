import { describe, expect, it } from "vitest";
import {
  DEFAULT_SSH_PORT,
  EMPTY_SSH_HOST_FORM,
  type SshHostForm,
  sshHostFields,
  sshHostFormComplete,
} from "./sshHostDraft";

const form = (over: Partial<SshHostForm> = {}): SshHostForm => ({
  ...EMPTY_SSH_HOST_FORM,
  host: "100.64.0.1",
  username: "kattpish",
  ...over,
});

describe("SSH 호스트 폼", () => {
  it("주소와 사용자만 있으면 저장할 수 있다", () => {
    expect(sshHostFormComplete(form())).toBe(true);
    expect(sshHostFields(form())).toEqual({
      host: "100.64.0.1",
      port: DEFAULT_SSH_PORT,
      username: "kattpish",
      // 라벨은 선택이다. 비워 두면 목록이 주소로 부른다 — 칸을 건너뛴 사람이
      // 어차피 적었을 이름이다.
      label: "100.64.0.1",
      // 아무것도 고르지 않았으면 이 기기 키다.
      auth: { kind: "device" },
    });
  });

  /**
   * 고른 방법에 아무것도 안 들어 있으면 아직 고른 것이 아니다 — 빈 비밀번호는
   * 비밀번호로 나가고, 못 읽은 키는 키가 아니다.
   */
  it("비밀번호나 키를 고른 뒤에는 그것도 차야 한다", () => {
    expect(sshHostFormComplete(form({ auth: { kind: "password", password: "" } }))).toBe(false);
    expect(sshHostFormComplete(form({ auth: { kind: "password", password: "hunter2" } }))).toBe(
      true,
    );
    expect(
      sshHostFormComplete(form({ auth: { kind: "imported", privateKeyPem: " ", fileName: "id" } })),
    ).toBe(false);
    expect(
      sshHostFormComplete(
        form({ auth: { kind: "imported", privateKeyPem: "KEY", fileName: "id_ed25519" } }),
      ),
    ).toBe(true);
  });

  it("주소나 사용자가 비면 저장할 수 없다", () => {
    expect(sshHostFormComplete(form({ host: "  " }))).toBe(false);
    expect(sshHostFormComplete(form({ username: "" }))).toBe(false);
  });

  /**
   * `Number(text) || 22` 이면 `"0"` 과 `"abc"` 가 둘 다 조용히 22 가 된다.
   * 0 은 u16 으로 멀쩡해서 Rust 도 통과시키고, 실패는 한참 뒤 연결 시점에
   * 정체불명의 오류로 나온다.
   */
  it("포트는 숫자이거나 비어 있어야 한다", () => {
    expect(sshHostFields(form({ port: "2222" }))?.port).toBe(2222);
    expect(sshHostFields(form({ port: " " }))?.port).toBe(DEFAULT_SSH_PORT);
    expect(sshHostFields(form({ port: "abc" }))).toBeUndefined();
    expect(sshHostFields(form({ port: "0" }))).toBeUndefined();
    expect(sshHostFields(form({ port: "65536" }))).toBeUndefined();
  });

  it("앞뒤 공백은 떨어뜨린다", () => {
    expect(sshHostFields(form({ host: " mac-mini ", label: " 맥미니 " }))).toMatchObject({
      host: "mac-mini",
      label: "맥미니",
    });
  });
});
