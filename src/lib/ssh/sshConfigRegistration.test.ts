import { describe, expect, it } from "vitest";
import type { SshConfigHost, SshHostConfig } from "@/types";
import {
  findRegisteredHost,
  isGroupOpen,
  parseSshHostDraft,
  serializeSshHostDraft,
  sshConfigHostDraft,
  sshConfigHostId,
} from "@/lib/ssh/sshConfigRegistration";

const configHost = (over: Partial<SshConfigHost> = {}): SshConfigHost => ({
  alias: "gate1",
  hostName: "10.0.0.1",
  ...over,
});

const registered = (over: Partial<SshHostConfig> = {}): SshHostConfig => ({
  id: "host-1",
  name: "gate1",
  host: "10.0.0.1",
  port: 22,
  user: "ubuntu",
  auth: "auto",
  ...over,
});

describe("sshConfigHostDraft", () => {
  it("User/Port가 없으면 로컬 사용자명과 22를 채운다", () => {
    expect(sshConfigHostDraft(configHost(), "kattpish")).toEqual({
      name: "gate1",
      sshConfigAlias: "gate1",
      host: "10.0.0.1",
      port: 22,
      user: "kattpish",
      auth: "auto",
      keyPath: undefined,
    });
  });

  it("IdentityFile이 있으면 키 인증으로 등록한다", () => {
    expect(
      sshConfigHostDraft(
        configHost({ user: "root", port: 2222, identityFile: "~/.ssh/id_ed25519" }),
        "kattpish",
      ),
    ).toEqual({
      name: "gate1",
      sshConfigAlias: "gate1",
      host: "10.0.0.1",
      port: 2222,
      user: "root",
      auth: "key",
      keyPath: "~/.ssh/id_ed25519",
    });
  });
});

describe("findRegisteredHost", () => {
  const draft = sshConfigHostDraft(configHost({ user: "ubuntu" }), "kattpish");

  it("uses the SSH config alias as the route identity", () => {
    const match = registered({
      sshConfigAlias: "GATE1",
      host: "different.example",
      user: "other",
    });
    expect(findRegisteredHost([match], draft)).toBe(match);
  });

  it("does not collapse different config routes with the same endpoint", () => {
    const otherRoute = registered({
      name: "other",
      sshConfigAlias: "through-other-bastion",
    });
    expect(findRegisteredHost([otherRoute], draft)).toBeUndefined();
  });

  it("backfills an exact pre-provenance import after explicit selection", () => {
    const legacy = registered();
    expect(findRegisteredHost([legacy], draft)).toBe(legacy);
  });

  it("does not backfill a legacy row after its endpoint diverged", () => {
    expect(findRegisteredHost([registered({ port: 2222 })], draft)).toBeUndefined();
  });

  it("빈 목록에서는 아무것도 찾지 않는다", () => {
    expect(findRegisteredHost([], draft)).toBeUndefined();
  });
});

it("derives one stable id from a config alias across app windows", () => {
  expect(sshConfigHostId("Gate-1")).toBe(sshConfigHostId("gate-1"));
  expect(sshConfigHostId(" gate-1 ")).toBe(sshConfigHostId("gate-1"));
  expect(sshConfigHostId("gate-1")).not.toBe(sshConfigHostId("gate.1"));
});

describe("드래그 페이로드", () => {
  it("직렬화한 초안을 그대로 되읽는다", () => {
    const draft = sshConfigHostDraft(configHost({ identityFile: "~/.ssh/k" }), "kattpish");
    expect(parseSshHostDraft(serializeSshHostDraft(draft))).toEqual(draft);
  });

  it("keyPath 없는 초안은 keyPath 없이 되읽는다", () => {
    const draft = sshConfigHostDraft(configHost(), "kattpish");
    const parsed = parseSshHostDraft(serializeSshHostDraft(draft));
    expect(parsed).toEqual({
      name: "gate1",
      sshConfigAlias: "gate1",
      host: "10.0.0.1",
      port: 22,
      user: "kattpish",
      auth: "auto",
    });
  });

  it("rejects a drag payload without config-route identity", () => {
    const raw = JSON.stringify({
      name: "manual",
      sshConfigAlias: "   ",
      host: "10.0.0.1",
      port: 22,
      user: "dev",
      auth: "auto",
    });

    expect(parseSshHostDraft(raw)).toBeNull();
  });

  it.each([
    ["JSON이 아님", "gate1"],
    ["객체가 아님", '"gate1"'],
    ["배열", "[]"],
    ["이름 없음", '{"host":"h","port":22,"user":"u","auth":"auto"}'],
    ["빈 이름", '{"name":"","host":"h","port":22,"user":"u","auth":"auto"}'],
    ["포트가 문자열", '{"name":"n","host":"h","port":"22","user":"u","auth":"auto"}'],
    ["포트 범위 밖", '{"name":"n","host":"h","port":70000,"user":"u","auth":"auto"}'],
    ["포트가 정수 아님", '{"name":"n","host":"h","port":22.5,"user":"u","auth":"auto"}'],
    ["모르는 인증 방식", '{"name":"n","host":"h","port":22,"user":"u","auth":"totp"}'],
    ["invalid SSH config alias type", '{"name":"n","sshConfigAlias":7,"host":"h","port":22,"user":"u","auth":"auto"}'],
    ["keyPath 타입 오류", '{"name":"n","host":"h","port":22,"user":"u","auth":"key","keyPath":7}'],
  ])("%s 페이로드는 무시한다", (_label, raw) => {
    expect(parseSshHostDraft(raw)).toBeNull();
  });

  // USER/USERNAME이 없으면 defaultUser가 빈 문자열이 된다. 클릭 경로는 그대로
  // 등록하므로, 드래그만 조용히 실패하면 같은 호스트가 경로에 따라 다르게 동작한다.
  it("사용자명이 비어도 클릭 경로와 똑같이 등록된다", () => {
    const draft = sshConfigHostDraft(configHost(), "");
    expect(draft.user).toBe("");
    expect(parseSshHostDraft(serializeSshHostDraft(draft))).toEqual(draft);
  });

  it("다른 앱이 넣은 텍스트를 등록으로 오해하지 않는다", () => {
    expect(parseSshHostDraft("")).toBeNull();
    expect(parseSshHostDraft("{}")).toBeNull();
  });
});

describe("isGroupOpen", () => {
  it("건드리지 않은 그룹은 기본값을 따른다", () => {
    const none = new Set<string>();
    expect(isGroupOpen(none, "registered", true)).toBe(true);
    expect(isGroupOpen(none, "~/.ssh/config", false)).toBe(false);
  });

  it("토글한 그룹은 기본값의 반대가 된다", () => {
    const toggled = new Set(["registered", "~/.ssh/config"]);
    expect(isGroupOpen(toggled, "registered", true)).toBe(false);
    expect(isGroupOpen(toggled, "~/.ssh/config", false)).toBe(true);
  });
});
