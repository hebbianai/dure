// StatsPage's designated store-wiring point (cluster wiring hook). Every
// global-store subscription the stats & usage page needs lives here; the
// component consumes the returned values and keeps rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { useStore } from "@/store";

export function useStatsPageState() {
  const stats = useStore((s) => s.stats);
  const accounts = useStore((s) => s.accounts);
  const savedScan = useStore((s) => s.uiPrefs?.usageScanProviders);
  const setUi = useStore((s) => s.setUiPrefs);
  // 기간은 저장한다 — 화면을 닫을 때마다 기본값으로 돌아가면, 짧은 창을 고른
  // 이유(첫 스캔이 분 단위로 걸린다)가 매번 무효가 된다.
  const savedDays = useStore((st) => st.uiPrefs?.usageScanDays);
  return { stats, accounts, savedScan, setUi, savedDays };
}
