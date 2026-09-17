import { create } from "zustand";
import { appCompatibility, type AppCompatibility } from "@/lib/ipc";
import {
  clearMaintenanceLaneInterval,
  setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";

/** 프론트↔백엔드 빌드 정합 상태 — 타이틀바 칩이 구독한다. */
interface BackendCompatibilityState {
  compatibility: AppCompatibility | null;
}

export const useBackendCompatibilityStore = create<BackendCompatibilityState>(
  () => ({ compatibility: null }),
);

/** 정합 상태 주기 감시. 트렁크가 빠른 dev에서는 프론트만 vite로 리로드되고
 *  Rust 백엔드는 옛 빌드로 남아 skew가 "나중에" 생긴다 — 부팅 시 1회 검사로는
 *  못 잡는다 (2026-07-28 connection error 사건, bd 5hc). 60초 간격 + 창 복귀
 *  시 재확인하고, 경고 로그는 모드가 바뀔 때만 남긴다. */
export function startBackendCompatibilityWatch(intervalMs = 60_000): () => void {
  let disposed = false;
  let lastMode: string | undefined;

  const probe = async () => {
    try {
      const compatibility = await appCompatibility(true);
      if (disposed) return;
      useBackendCompatibilityStore.setState({ compatibility });
      document.documentElement.dataset.backendCompatibility = compatibility.mode;
      document.documentElement.dataset.frontendBuild = compatibility.frontendBuildId;
      document.documentElement.dataset.backendBuild =
        compatibility.backend?.buildId ?? "legacy";
      document.documentElement.dataset.backendCompatibilityBasis =
        compatibility.comparisonBasis;
      document.documentElement.dataset.frontendRuntimeFingerprint =
        compatibility.frontendRuntimeFingerprint ?? "unavailable";
      document.documentElement.dataset.backendRuntimeFingerprint =
        compatibility.backend?.runtimeFingerprint ?? "unavailable";
      if (compatibility.mode !== lastMode) {
        lastMode = compatibility.mode;
        if (compatibility.mode !== "current") {
          console.warn("[backend compatibility]", compatibility);
        }
      }
    } catch {
      /* 백엔드 무응답 — 다음 주기에 재시도 */
    }
  };

  void probe();
  const timer = setMaintenanceLaneInterval(
    () => {
      if (document.visibilityState !== "hidden") void probe();
    },
    intervalMs,
    "backend-compatibility",
  );
  const onVisibility = () => {
    if (document.visibilityState === "visible") void probe();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    disposed = true;
    clearMaintenanceLaneInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
