import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { Titled } from "@/components/ui/tooltip";
import { CodeBlock } from "@/components/common/CodeBlock";
import { PageTitle } from "@/components/settings/PageTitle";
import { ProviderCliQuarantineNotice } from "@/components/settings/ProviderCliQuarantineNotice";
import { ProviderCliUpdateRow } from "@/components/settings/ProviderCliUpdateRow";
import { SettingRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { StatusDot } from "@/components/ui/status-dot";
import {
  providerPreflight,
  providerWiringFile,
  providerWiringStatus,
  type ProviderPreflight,
  type ProviderWiringFile,
  type ProviderWiringFileKind,
  type ProviderWiringStatus,
} from "@/lib/ipc";
import { activeAccount, supportsAccounts } from "@/lib/agents/providers";
import { useAvailableProviders } from "@/lib/agents/agentInstalls";
import { providerExecutable } from "@/lib/agents/providerPreflight";
import {
  completionSource,
  hasCompletionSource,
  providerWiringRows,
  type CodexWiringRow,
} from "@/lib/settings/providerWiring";
import {
  preflightDisplay,
  type PreflightDisplay,
} from "@/lib/settings/providerPreflightStatus";
import {
  providerCapabilities,
  type ProviderCapabilityKey,
} from "@/lib/settings/providerCapabilities";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";
import { PROVIDERS, type Provider } from "@/types";
import { cn } from "@/lib/utils";

/** 상태 텍스트의 톤 — 시안은 정상 상태를 전부 muted로 조용히 둔다. 눈에 띄는
 *  색은 사람이 손대야 하는 자리(미충족·근사 추론)에만 쓴다. */
/** 한 번에 띄우는 로그인 셸 수. 3이면 19개 CLI가 6~7묶음으로 끊겨 각 묶음이
 *  제 예산을 온전히 쓴다. */
const PREFLIGHT_CONCURRENCY = 3;

const OK_TONE = "text-muted-foreground";
const WARN_TONE = "text-status-warn";

/** 3상 상태 텍스트 — 충족/미충족은 각 행이 자기 낱말을 쓰고(§6 레이블이 곧
 *  벌어지는 일), 해당 없음(null)만 공통 문구다. */
function stateText(
  value: boolean | null,
  labels: { on: string; off: string },
): { label: string; tone: string } {
  if (value === null) return { label: t("settings.providers.wiring.notApplicable"), tone: OK_TONE };
  return value
    ? { label: labels.on, tone: OK_TONE }
    : { label: labels.off, tone: WARN_TONE };
}

/** 상태 행 (시안 2535:65979) — 제목 줄 오른쪽 끝에 상태 낱말이 붙고, 설명은
 *  그 아래 본문 폭을 그대로 쓴다. FlatRow와 달리 상태가 두 줄 사이에 끼어
 *  가운데 정렬되지 않으므로, 설명이 길어져도 상태는 제목과 같은 줄에 남는다. */
type ChipTone = "ok" | "warn" | "muted";

/** A status as a dot and a word: the tone lives in the dot, the word stays
 *  quiet, so a row's right edge is the same small thing on every row. */
function StatusChip({ label, tone }: { label: string; tone: ChipTone }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-meta font-medium text-muted-foreground">
      <StatusDot tone={tone === "ok" ? "done" : tone === "warn" ? "warn" : "muted"} />
      {label}
    </span>
  );
}

const CODEX_ROW_COPY: Record<
  CodexWiringRow["key"],
  () => { title: string; desc: string; on: string; off: string }
> = {
  notifyPublished: () => ({
    title: t("settings.providers.wiring.reportScriptTitle"),
    desc: t("settings.providers.wiring.reportScriptDesc"),
    on: t("settings.providers.wiring.deployed"),
    off: t("settings.providers.wiring.notDeployed"),
  }),
  notifyMerged: () => ({
    title: t("settings.providers.wiring.overlayTitle"),
    desc: t("settings.providers.wiring.overlayDesc"),
    on: t("common.connected"),
    off: t("settings.providers.wiring.notWired"),
  }),
  trustRekeyed: () => ({
    title: t("settings.providers.wiring.hookTrustTitle"),
    desc: t("settings.providers.wiring.hookTrustDesc"),
    on: t("settings.providers.wiring.hookTrustOn"),
    off: t("settings.providers.wiring.hookTrustOff"),
  }),
};

/** provider별 raw 파일 목록 — 배선 행이 실제로 가리키는 파일들. 토큰 파일은
 *  백엔드 enum에서 제외돼 있다. */
const RAW_FILES: Partial<
  Record<Provider, { kind: ProviderWiringFileKind; label: () => string }[]>
> = {
  claude: [
    { kind: "claudeManagedSettings", label: () => "managed-claude-settings.json" },
  ],
  codex: [
    { kind: "codexNotifyScript", label: () => "managed-codex-notify.sh" },
    { kind: "codexOverlayConfig", label: () => t("settings.providers.rawFiles.codexOverlayConfig") },
    { kind: "codexCanonicalConfig", label: () => "~/.codex/config.toml" },
    { kind: "codexCanonicalHooks", label: () => "~/.codex/hooks.json" },
  ],
};

/** 능력 축의 이름 — 매니페스트의 필드명이 아니라 사람이 쓰는 낱말로 옮긴다. */
const CAPABILITY_LABEL: Record<ProviderCapabilityKey, () => string> = {
  resume: () => t("settings.providers.capability.resume"),
  resumeById: () => t("settings.providers.capability.resumeById"),
  conversationList: () => t("settings.providers.capability.conversationList"),
  fork: () => t("settings.providers.capability.fork"),
  accountIsolation: () => t("settings.providers.capability.accountIsolation"),
  login: () => t("common.login"),
  accountPage: () => t("settings.providers.capability.accountPage"),
  skipPermissions: () => t("settings.providers.capability.skipPermissions"),
  workflowDelegate: () => t("common.delegateTask"),
  model: () => t("settings.providers.capability.model"),
  headless: () => t("settings.providers.capability.headless"),
  mcp: () => t("settings.providers.capability.mcp"),
  configFile: () => t("settings.providers.capability.configFile"),
  configDirEnv: () => t("settings.providers.capability.configDirEnv"),
};

/** 이 앱이 그 CLI로 실제로 할 수 있는 것들. 지원하는 것만 근거(명령·플래그)와
 *  함께 칩으로 늘어놓고, 지원하지 않는 것은 이름만 한 줄로 모은다 — 19개
 *  provider × 9개 축을 전부 행으로 펴면 "미지원"이 화면의 대부분을 차지해서
 *  정작 할 수 있는 것이 묻힌다. */
/** The four things a CLI is asked to do, so fourteen commands read as four
 *  short lists with the command on one axis instead of fourteen pills each
 *  carrying its own. Order inside a group follows providerCapabilities. */
const CAPABILITY_GROUPS: ReadonlyArray<{
  key: string;
  label: () => string;
  keys: readonly ProviderCapabilityKey[];
}> = [
  {
    key: "conversations",
    label: () => t("settings.providers.capability.group.conversations"),
    keys: ["resume", "resumeById", "conversationList", "fork"],
  },
  {
    key: "account",
    label: () => t("settings.providers.capability.group.account"),
    keys: ["accountIsolation", "login", "accountPage", "configDirEnv"],
  },
  {
    key: "run",
    label: () => t("settings.providers.capability.group.run"),
    keys: ["workflowDelegate", "model", "headless", "skipPermissions"],
  },
  {
    key: "setup",
    label: () => t("settings.providers.capability.group.setup"),
    keys: ["mcp", "configFile"],
  },
];

function CapabilityList({ provider }: { provider: Provider }) {
  const rows = providerCapabilities(provider);
  const supported = rows.filter((row) => row.supported);
  const missing = rows.length - supported.length;
  // The count says what it counts: all of them, or how many are not there —
  // and the ones that are not stay in their group, dimmed, so the reader
  // sees which (owner call 2026-09-14). "14/14" said neither.
  const count =
    missing === 0
      ? t("settings.providers.capability.allAvailable", { count: rows.length })
      : t("settings.providers.capability.someAvailable", {
          supported: supported.length,
          total: rows.length,
          missing,
        });
  return (
    // Row, then its card 12 under — the Accounts page's header-to-cards gap.
    // @container: the card's two columns key off this block's width.
    <div className="@container flex w-full flex-col gap-3">
      <SettingRow title={t("settings.providers.capability.sectionTitle")} align="center">
        <span className={cn("text-xs", supported.length === 0 ? WARN_TONE : OK_TONE)}>{count}</span>
      </SettingRow>
      {supported.length === 0 ? (
        <p className="w-full text-xs text-muted-foreground">
          {t("settings.providers.capability.noneConfirmed")}
        </p>
      ) : (
        // The Accounts page's card, holding the four groups two abreast.
        <Card className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-[11px] @md:grid-cols-2">
          {CAPABILITY_GROUPS.map((group) => {
            const items = rows.filter((row) => group.keys.includes(row.key));
            if (items.length === 0) return null;
            return (
              <div key={group.key} className="flex flex-col">
                {/* The settings pages' own section label (SettingsSection), not
                    a tracked capital: nothing else in Settings shouts. */}
                <span className="pb-0.5 text-[11px] leading-[18px] font-medium text-muted-foreground">
                  {group.label()}
                </span>
                {items.map((row) => (
                  <div
                    key={row.key}
                    className={cn(
                      "flex items-baseline justify-between gap-3 py-1 text-xs",
                      !row.supported && "text-muted-foreground/60",
                    )}
                  >
                    <span className="shrink-0">{CAPABILITY_LABEL[row.key]()}</span>
                    <Titled title={row.detail}>
                      <span
                        className={cn(
                          "min-w-0 truncate text-right font-mono text-meta",
                          row.supported ? "text-muted-foreground" : "text-muted-foreground/40",
                        )}
                      >
                        {row.supported ? row.detail : "—"}
                      </span>
                    </Titled>
                  </div>
                ))}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

interface OpenRawFile {
  provider: Provider;
  kind: ProviderWiringFileKind;
  file: ProviderWiringFile | null;
  error: string | null;
}

/** 프로브 한 번의 3상. "아직 안 왔다"와 "물어봤는데 실패했다"를 분리한다 —
 *  둘 다 `wiring === null`로 수렴시키면 화면은 영원히 "확인 중"이라고 거짓말을
 *  하거나, 모르는 것을 "미충족"이라고 단언하게 된다. */
type ProbeState = "loading" | "failed" | "ready";

function probeStateText(state: ProbeState): { label: string; tone: string } {
  return state === "failed"
    ? { label: t("common.unverified"), tone: WARN_TONE }
    : { label: t("common.checking"), tone: OK_TONE };
}

/** 완료 알림 소스 한 칸. 낱말로 바꾸면서 "아직 모른다"를 반드시 분리해야 한다 —
 *  `wiring === null`은 프로브 응답 전이거나 프로브가 실패한 상태이고,
 *  `completionSource`는 그때도 `inference`를 돌려준다. 그걸 그대로 경고색으로
 *  그리면 배선이 멀쩡한 기기에서도 새로고침마다 세 섹션이 "완료 알림 없음"으로
 *  깜빡이고, 프로브가 실패하면 그 경고가 영구히 남는다. */
function completionCopy(
  provider: Provider,
  wiring: ProviderWiringStatus | null,
  state: ProbeState,
  providerVersion: string | undefined,
): { label: string; tone: string } {
  if (!hasCompletionSource(provider)) {
    return { label: t("settings.providers.wiring.notApplicable"), tone: OK_TONE };
  }
  if (state !== "ready") return probeStateText(state);
  const source = completionSource(provider, wiring, providerVersion);
  if (source === "hook_events") {
    return { label: t("settings.providers.notifySource.hookEvents"), tone: OK_TONE };
  }
  if (source === "turn_notify") {
    return { label: t("settings.providers.notifySource.turnReport"), tone: OK_TONE };
  }
  return { label: t("settings.providers.notifySource.screenInference"), tone: WARN_TONE };
}

/** CLI 한 칸. 판정은 순수 모듈이 하고 여기서는 낱말만 고른다 — `ready`
 *  불리언만 보던 시절에는 로그인 셸 환경 조회가 시간 안에 안 끝난 것까지
 *  "설치 안 됨"으로 단언해, 멀쩡히 깔린 CLI를 두고 재설치하러 가게 만들었다
 *  (2026-08-11 실측). */
const PREFLIGHT_LABEL: Record<PreflightDisplay["key"], () => string> = {
  checking: () => t("common.checking"),
  installed: () => t("common.installed"),
  unknown: () => t("common.unverified"),
  missing: () => t("common.notInstalled"),
  unusable: () => t("settings.providers.cli.unusable"),
};

/** The page's older text-tone statuses (a colour class) as a chip tone. */
function chipTone(status: { label: string; tone: string }): {
  label: string;
  tone: ChipTone;
} {
  return { label: status.label, tone: status.tone === WARN_TONE ? "warn" : "ok" };
}

function cliStatus(
  preflight: ProviderPreflight | null | undefined,
): { label: string; tone: string } {
  const display = preflightDisplay(preflight);
  return {
    label: PREFLIGHT_LABEL[display.key](),
    tone: display.tone === "ok" ? OK_TONE : WARN_TONE,
  };
}

/** 설정 › 프로바이더 — provider별 CLI·계정·완료 알림 배선의 현재 상태.
 *  전부 읽기 전용 프로브다(상태 조회가 오버레이를 바꾸지 않는다).
 *  Exception: the per-provider ProviderCliUpdateRow is the page's one
 *  mutating action — it runs the channel-correct update command after
 *  re-verifying a fresh detection.
 *
 *  시안 2535:65959 개편: provider마다 두르던 720px 카드를 걷어내고, 섹션들을
 *  hairline 한 줄로만 나눈다. 상태는 ✓/– 마크 대신 낱말("설치됨"·"배포됨")로
 *  제목 줄 오른쪽에 붙는다 — 마크는 무엇이 충족됐다는 건지 스스로 말하지 못해
 *  왼쪽 설명을 매번 되짚어 읽어야 했다. */
export function ProvidersPage() {
  const accounts = useStore((state) => state.accounts);
  const activeAccounts = useStore((state) => state.activeAccounts);
  const skipPermissions = useStore((state) => state.skipPermissions);
  const [wiring, setWiring] = useState<ProviderWiringStatus | null>(null);
  const [wiringFailed, setWiringFailed] = useState(false);
  const [preflights, setPreflights] = useState<
    Partial<Record<Provider, ProviderPreflight | null>>
  >({});
  const [rawFile, setRawFile] = useState<OpenRawFile | null>(null);
  // 계정 분리를 지원하는 셋만 싣던 자리. 설치해 둔 나머지 CLI는 "이 앱이 이걸로
  // 무엇을 할 수 있는지" 물어볼 곳이 아예 없었다 — 실행은 되는데 연동 상태를
  // 확인할 화면이 없으니 "인식이 안 된다"로 읽힌다.
  const providers = useAvailableProviders();
  // providers는 매 렌더 새 배열이라 그대로 의존성에 넣으면 probe가 무한히
  // 다시 만들어진다 — 내용이 같으면 같은 참조가 되게 키로 묶는다.
  const providerKey = providers.join(",");
  const probeTargets = useMemo(
    () => (providerKey === "" ? [] : (providerKey.split(",") as Provider[])),
    [providerKey],
  );
  const wiringState: ProbeState = wiringFailed
    ? "failed"
    : wiring === null
      ? "loading"
      : "ready";

  const toggleRawFile = (provider: Provider, kind: ProviderWiringFileKind) => {
    if (rawFile?.provider === provider && rawFile.kind === kind) {
      setRawFile(null);
      return;
    }
    setRawFile({ provider, kind, file: null, error: null });
    providerWiringFile(kind, activeAccount("codex")?.dir)
      .then((file) =>
        setRawFile((current) =>
          current?.provider === provider && current.kind === kind
            ? { ...current, file }
            : current,
        ),
      )
      .catch((error: unknown) =>
        setRawFile((current) =>
          current?.provider === provider && current.kind === kind
            ? { ...current, error: String(error) }
            : current,
        ),
      );
  };

  // Re-probes only this one provider after ProviderCliUpdateRow's sole write
  // path (a successful update) — unlike probe(), it never resets the whole
  // page to loading, so the other provider sections do not flicker while the
  // user is just watching this one badge advance.
  const refreshPreflight = useCallback(async (provider: Provider) => {
    try {
      const preflight = await providerPreflight({
        provider,
        command: providerExecutable(provider),
        cwd: "/",
      });
      setPreflights((current) => ({ ...current, [provider]: preflight }));
    } catch {
      setPreflights((current) => ({ ...current, [provider]: null }));
    }
  }, []);

  const probe = useCallback(async () => {
    setWiring(null);
    setWiringFailed(false);
    setPreflights({});
    const codexDir = activeAccount("codex")?.dir;
    void providerWiringStatus(codexDir)
      .then(setWiring)
      .catch(() => {
        setWiring(null);
        setWiringFailed(true);
      });
    // preflight 하나가 로그인 셸을 새로 띄운다. 예전에는 대상이 셋이라 전부
    // 동시에 쏴도 괜찮았지만, 설치된 CLI 전부로 늘리자 19개가 서로 밀려
    // 로그인 셸 환경 조회가 3초 예산을 넘겼다 — 그리고 그 타임아웃이 화면에
    // "설치 안 됨"으로 나왔다. 몇 개씩 끊어 보낸다.
    const queue = [...probeTargets];
    const runOne = async (): Promise<void> => {
      const provider = queue.shift();
      if (!provider) return;
      try {
        const preflight = await providerPreflight({
          provider,
          command: providerExecutable(provider),
          cwd: "/",
        });
        setPreflights((current) => ({ ...current, [provider]: preflight }));
      } catch {
        setPreflights((current) => ({ ...current, [provider]: null }));
      }
      await runOne();
    };
    await Promise.all(
      Array.from({ length: Math.min(PREFLIGHT_CONCURRENCY, queue.length) }, runOne),
    );
  }, [probeTargets]);

  useEffect(() => {
    void probe();
  }, [probe]);

  return (
    <>
      <PageTitle
        title={t("settings.providers.title")}
        desc={t("settings.providers.description")}
      />
      <div className="flex w-full flex-col">
        {providers.map((provider, idx) => {
          const spec = PROVIDERS[provider];
          const preflight = preflights[provider];
          const account = activeAccounts[provider]
            ? accounts.find((candidate) => candidate.id === activeAccounts[provider])
            : undefined;
          const completion = completionCopy(provider, wiring, wiringState, preflight?.version);
          const versionLabel = preflight?.version?.replace(
            /\s*\(([^)]*)\)\s*$/,
            (match, inner: string) => (inner.trim() === spec.label ? "" : match),
          );
          const rawFiles = RAW_FILES[provider];
          return (
            // The section's own 24px between rows, as every settings page.
            <SettingsSection key={provider} first={idx === 0}>
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  {/* 계정 페이지와 같은 취급 — 20px 자리에 심볼만, 틴트 박스 없이.
                      색은 넘기지 않는다: 톤은 ProviderGlyph 한 곳에서 정한다. */}
                  <ProviderGlyph provider={provider} className="size-5 shrink-0" />
                  <span className="text-sm font-medium text-foreground">{spec.label}</span>
                  {versionLabel && (
                    // The Accounts page's "Active" chip, carrying the version —
                    // the CLI's own "(Claude Code)" suffix dropped when it only
                    // repeats the name beside it.
                    <Badge size="sm" variant="secondary" className="font-mono">
                      {versionLabel}
                    </Badge>
                  )}
                </div>
                <p className="max-w-[600px] text-xs text-muted-foreground">
                  {t("settings.providers.providerDesc")}
                </p>
              </div>

              {/* The three facts as the settings pages' own rows: title, a
                  description, the status in the right-hand slot as a dot chip
                  (owner call 2026-09-14: this page in the app's style). */}
                <SettingRow
                  title="CLI"
                  // 응답 전에는 설명을 비운다 — 상태 낱말이 이미 "확인 중…"이라
                  // 같은 말을 두 줄에 겹쳐 쓰면 오른쪽 칸이 왼쪽을 되풀이할 뿐이다.
                  desc={
                    preflight === undefined
                      ? undefined
                      : preflight === null
                        ? t("settings.providers.statusCheckFailed")
                        : !preflight.ready
                          ? preflight.message
                          : (
                              <span className="font-mono break-all">
                                {preflight.resolvedPath ?? preflight.commandPath ?? spec.cmd}
                              </span>
                            )
                  }
                >
                  <StatusChip {...chipTone(cliStatus(preflight))} />
                </SettingRow>
                {supportsAccounts(provider) && (
                  <SettingRow
                    title={t("settings.providers.activeAccount.title")}
                    desc={
                      account ? account.name : t("settings.providers.activeAccount.systemDefault")
                    }
                  >
                    {account ? (
                      <StatusChip label={t("settings.providers.activeAccount.managed")} tone="ok" />
                    ) : (
                      <StatusChip label={t("settings.providers.activeAccount.unmanaged")} tone="muted" />
                    )}
                  </SettingRow>
                )}
                <SettingRow
                  title={t("settings.providers.notifySource.title")}
                  desc={t("settings.providers.notifySource.desc")}
                >
                  <StatusChip {...chipTone(completion)} />
                </SettingRow>
              {preflight?.ready && (
                <ProviderCliUpdateRow
                  provider={provider}
                  preflight={preflight}
                  refreshPreflight={refreshPreflight}
                />
              )}
              {preflight && !preflight.ready && (
                <ProviderCliQuarantineNotice
                  provider={provider}
                  preflight={preflight}
                  refreshPreflight={refreshPreflight}
                />
              )}
              <CapabilityList provider={provider} />
              {providerWiringRows(provider, wiring).map((row) => {
                const copy = CODEX_ROW_COPY[row.key]();
                return (
                  <SettingRow key={row.key} title={copy.title} desc={copy.desc}>
                    {/* 응답 전/실패에는 row.value의 false/null 구분을 믿지 않는다 —
                        아직 물어보지도 않은 사실을 "미충족"으로 단언하게 된다. */}
                    <StatusChip
                      {...chipTone(
                        wiringState === "ready"
                          ? stateText(row.value, copy)
                          : probeStateText(wiringState),
                      )}
                    />
                  </SettingRow>
                );
              })}
              {skipPermissions[provider] && (
                <SettingRow
                  title={t("settings.providers.skipPermissions.title")}
                  desc={t("settings.providers.skipPermissions.desc")}
                >
                  <StatusChip label={t("common.on")} tone="warn" />
                </SettingRow>
              )}
              {rawFiles && (
                <div className="flex w-full flex-col gap-3">
                  <SettingRow
                    title={t("settings.providers.rawFiles.title")}
                    desc={t("settings.providers.rawFiles.desc")}
                  />
                  <div className="flex flex-wrap gap-2">
                    {rawFiles.map(({ kind, label }) => {
                      const open = rawFile?.provider === provider && rawFile.kind === kind;
                      return (
                        <Button
                          key={kind}
                          type="button"
                          variant={open ? "outline" : "ghost"}
                          className="h-8 gap-2 rounded-md px-2 text-xs"
                          aria-expanded={open}
                          // aria-expanded만 두면 "펼쳐짐"이라고 읽히는데 펼쳐진
                          // 것이 어디 있는지는 알려주지 못한다 — 뷰어가 버튼
                          // 목록의 형제라 인접 관계로도 찾을 수 없다.
                          aria-controls={`raw-file-${provider}-${kind}`}
                          onClick={() => toggleRawFile(provider, kind)}
                        >
                          {/* 열려도 셰브런을 빼지 않고 돌린다 — 아이콘이 사라지면
                              누른 순간 버튼 폭이 튄다. */}
                          <DisclosureChevron open={open} className="text-current" />
                          {label()}
                        </Button>
                      );
                    })}
                  </div>
                  {rawFile?.provider === provider && (
                    <div
                      id={`raw-file-${provider}-${rawFile.kind}`}
                      className="flex flex-col gap-1.5"
                    >
                      {rawFile.file && (
                        <span className="font-mono text-[11px] break-all text-muted-foreground">
                          {rawFile.file.path}
                          {rawFile.file.truncated && ` — ${t("settings.providers.rawFiles.truncated")}`}
                        </span>
                      )}
                      {rawFile.error ? (
                        <span className="text-xs text-muted-foreground">{rawFile.error}</span>
                      ) : rawFile.file ? (
                        // 이 표면만 유지하는 드리프트: 테두리 없는 bg-foreground/5 채움.
                        <CodeBlock
                          maxHeightClass="max-h-72"
                          className="border-0 bg-foreground/5 leading-relaxed break-all text-foreground"
                        >
                          {rawFile.file.content}
                        </CodeBlock>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("common.checking")}</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </SettingsSection>
          );
        })}
        {/* 시안에는 없지만(프레임이 두 섹션에서 잘려 있다) 프로브를 다시 돌릴
            길은 이 페이지에만 있다 — 카드를 걷어낸 자리에 같은 리듬의 행으로 남긴다. */}
        <div className="flex w-full items-center justify-between border-t border-border py-6 pr-2">
          <span className="text-sm font-medium text-foreground">{t("common.recheck")}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void probe()}
            aria-label={t("common.recheck")}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
    </>
  );
}
