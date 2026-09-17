// 설정 > 통계 및 사용량의 provider별 사용량 카드 — SettingsDialog에서 추출
// (god-file 다이어트). 어느 계정 credential 맥락인지도 함께 보여준다.
import { t } from "@/lib/i18n";
import type { Provider } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { UsageAccountRow } from "@/components/usage/ProviderUsageDetail";
import { fmtTokens } from "@/lib/usage/usageMeter";

// 데이터 형태는 lib/usage 소유(순환 제거) — 기존 임포터를 위해 재-export.
import type { ProvStats } from "@/lib/usage/providerStats";
export type { ProvStats } from "@/lib/usage/providerStats";

export function ProviderUsageCard({
  label,
  provider,
  s,
  pct,
  scanning = true,
}: {
  label: string;
  provider: Provider;
  s: ProvStats;
  pct: number;
  /** 스캔 대상 여부. 배지가 데이터 유무가 아니라 이 상태를 말한다 —
   *  꺼둔 공급자는 데이터가 0인 것이 정상이라 "데이터 없음"이 오해를 준다. */
  scanning?: boolean;
}) {
  return (
    <Card className="flex min-w-0 flex-1 flex-col gap-2 rounded-[12px]">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <Badge size="sm" variant="secondary">
          {scanning ? t("common.active") : t("common.off")}
        </Badge>
      </div>
      <div className="flex flex-col gap-0.5">
        <UsageAccountRow provider={provider} />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>{t("usage.tokens.count", { n: fmtTokens(s.total) })}</span>
        <span>{t("usage.stats.sessionsTurns", { s: s.sessions, t: s.turns })}</span>
        <span className="opacity-70">
          {s.usedPercent != null ? `${Math.round(s.usedPercent)}%` : "n/a"}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </Card>
  );
}
