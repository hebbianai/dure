import { describe, expect, it } from "vitest";
import {
  EMPTY_HOST_KEYS_DRAFT,
  canSave,
  clearDraft,
  keysScreenModel,
  withDraft,
} from "./hostKeys";

describe("canSave", () => {
  it("빈 칸과 공백만 있는 칸은 저장할 수 없다", () => {
    expect(canSave("")).toBe(false);
    expect(canSave("   \n")).toBe(false);
  });

  // PEM 이 아닌 것을 저장하면 Rust 가 거부하고 배너가 그것을 말하지만, 그때는
  // 이미 붙여넣은 것이 무엇인지 사람이 잊은 뒤다. 단추가 먼저 말한다.
  it("-----BEGIN 으로 시작하는 것만 저장할 수 있다", () => {
    expect(canSave("ssh-ed25519 AAAA")).toBe(false);
    expect(canSave("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----")).toBe(
      true,
    );
    expect(canSave("\n  -----BEGIN RSA PRIVATE KEY-----\n")).toBe(true);
  });
});

describe("drafts", () => {
  it("한 슬롯을 고쳐도 다른 슬롯은 그대로다", () => {
    const next = withDraft(EMPTY_HOST_KEYS_DRAFT, "list", "-----BEGIN");
    expect(next).toEqual({ attach: "", list: "-----BEGIN" });
    expect(withDraft(next, "attach", "x")).toEqual({ attach: "x", list: "-----BEGIN" });
  });

  it("저장한 슬롯만 비운다", () => {
    const both = { attach: "a", list: "b" };
    expect(clearDraft(both, "attach")).toEqual({ attach: "", list: "b" });
    expect(clearDraft(both, "list")).toEqual({ attach: "a", list: "" });
  });
});

describe("keysScreenModel", () => {
  const server = {
    label: "Loopback lab",
    paired: true,
    has_attach_key: true,
    has_list_key: false,
  };

  it("서버의 사실과 화면의 상태를 한 모델로 합친다", () => {
    const model = keysScreenModel(server, {
      publicKey: "ssh-ed25519 AAAA phone",
      drafts: { attach: "", list: "x" },
    });
    expect(model).toEqual({
      label: "Loopback lab",
      paired: true,
      publicKey: "ssh-ed25519 AAAA phone",
      publicKeyFailure: undefined,
      copied: false,
      drafts: { attach: "", list: "x" },
      stored: { attach: true, list: false },
    });
  });

  it("복사됨은 화면 상태에서 온다", () => {
    expect(
      keysScreenModel(server, { copied: true, drafts: EMPTY_HOST_KEYS_DRAFT }).copied,
    ).toBe(true);
  });
});
