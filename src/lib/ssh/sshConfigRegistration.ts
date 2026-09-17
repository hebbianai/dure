import type { SshConfigHost, SshHostConfig } from "@/types";
import { LEGACY_PRODUCT_COMPATIBILITY } from "@/lib/platform/legacyProductCompatibility";

/** 설정 파일 호스트를 사이드바에서 드래그할 때 쓰는 dataTransfer 타입. */
export const SSH_CONFIG_HOST_DRAG_TYPE = "dure/ssh-config-host";
const SSH_CONFIG_HOST_DRAG_INPUT_TYPES = [
  SSH_CONFIG_HOST_DRAG_TYPE,
  LEGACY_PRODUCT_COMPATIBILITY.sshConfigHostDragType,
] as const;

export function hasSshConfigHostDragType(types: readonly string[]): boolean {
  return SSH_CONFIG_HOST_DRAG_INPUT_TYPES.some((type) => types.includes(type));
}

export function readSshConfigHostDragData(
  dataTransfer: Pick<DataTransfer, "getData">,
): SshConfigHostDraft | null {
  const current = dataTransfer.getData(SSH_CONFIG_HOST_DRAG_TYPE);
  if (current) return parseSshHostDraft(current);
  const legacy = dataTransfer.getData(LEGACY_PRODUCT_COMPATIBILITY.sshConfigHostDragType);
  return legacy ? parseSshHostDraftValue(legacy, true) : null;
}

/** 등록 전 초안 — 저장소가 id를 붙이기 전 상태. */
type SshHostDraft = Omit<SshHostConfig, "id" | "registrationGeneration">;
export type SshConfigHostDraft = SshHostDraft & { sshConfigAlias: string };

const AUTH_MODES: ReadonlySet<string> = new Set(["auto", "password", "key"]);

export function normalizeSshConfigAlias(alias: string | undefined): string | undefined {
  const normalized = alias?.trim();
  return normalized ? normalized : undefined;
}

/** `~/.ssh/config` 호스트 → 등록 호스트 초안. `User`가 없으면 로컬 사용자명을 쓴다. */
export function sshConfigHostDraft(
  host: SshConfigHost,
  defaultUser: string,
): SshConfigHostDraft {
  return {
    name: host.alias,
    sshConfigAlias: host.alias.trim(),
    host: host.hostName,
    port: host.port ?? 22,
    user: host.user ?? defaultUser,
    // IdentityFile이 있으면 그 키로, 없으면 ssh-agent + 기본 키(auto).
    auth: host.identityFile ? "key" : "auto",
    keyPath: host.identityFile,
  };
}

/** Finds one registered projection of an explicitly selected SSH config route.
 *  Manual rows never pass through this identity policy. */
export function findRegisteredHost(
  hosts: readonly SshHostConfig[],
  draft: SshConfigHostDraft,
): SshHostConfig | undefined {
  const alias = draft.sshConfigAlias.toLowerCase();
  const routed = hosts.find(
    (host) => normalizeSshConfigAlias(host.sshConfigAlias)?.toLowerCase() === alias,
  );
  if (routed) return routed;
  // Explicit selection is the conservative migration boundary for an
  // untouched pre-provenance import. Ambiguous customized/manual rows remain
  // separate instead of being silently reclassified.
  return hosts.find(
    (host) =>
      normalizeSshConfigAlias(host.sshConfigAlias) === undefined &&
      host.name === draft.name &&
      host.host === draft.host &&
      host.port === draft.port &&
      host.user === draft.user &&
      host.auth === draft.auth &&
      host.keyPath === draft.keyPath,
  );
}

/** Stable identity for one OpenSSH config destination across app windows. */
export function sshConfigHostId(alias: string): string {
  const encoded = Array.from(new TextEncoder().encode(alias.trim().toLowerCase()), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `host-ssh-config-${encoded}`;
}

/** 드롭 쪽은 설정 파일을 다시 스캔하지 않고 이 초안만으로 등록한다. */
export function serializeSshHostDraft(draft: SshConfigHostDraft): string {
  return JSON.stringify(draft);
}

/** 드래그 페이로드 역직렬화 — 외부에서 온 문자열이라 형태를 모두 검사한다.
 *  잘못된 페이로드는 null이 되어 드롭이 조용히 무시된다. */
export function parseSshHostDraft(raw: string): SshConfigHostDraft | null {
  return parseSshHostDraftValue(raw, false);
}

function parseSshHostDraftValue(
  raw: string,
  legacyAliasFromName: boolean,
): SshConfigHostDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { name, sshConfigAlias, host, port, user, auth, keyPath } = value as Record<
    string,
    unknown
  >;
  if (typeof name !== "string" || !name) return null;
  if (typeof host !== "string" || !host) return null;
  // user는 비어 있을 수 있다 — USER/USERNAME이 없는 환경에서 defaultUser가 빈
  // 문자열이 된다. 클릭 경로도 그대로 등록하므로 드래그만 조용히 실패하면 안 된다.
  if (typeof user !== "string") return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof auth !== "string" || !AUTH_MODES.has(auth)) return null;
  if (sshConfigAlias !== undefined && typeof sshConfigAlias !== "string") return null;
  if (keyPath !== undefined && typeof keyPath !== "string") return null;
  const normalizedAlias =
    normalizeSshConfigAlias(sshConfigAlias) ??
    (legacyAliasFromName && sshConfigAlias === undefined
      ? normalizeSshConfigAlias(name)
      : undefined);
  if (!normalizedAlias) return null;
  return {
    name,
    sshConfigAlias: normalizedAlias,
    host,
    port,
    user,
    auth: auth as SshHostConfig["auth"],
    ...(keyPath === undefined ? {} : { keyPath }),
  };
}

/** 그룹마다 기본 펼침이 다르다(등록 목록은 펼침, 설정 파일은 접힘) — 사용자가
 *  기본값에서 바꾼 그룹만 기억하므로, 스캔이 갱신돼도 선택이 유지된다. */
export function isGroupOpen(
  toggled: ReadonlySet<string>,
  key: string,
  defaultOpen: boolean,
): boolean {
  return toggled.has(key) ? !defaultOpen : defaultOpen;
}
