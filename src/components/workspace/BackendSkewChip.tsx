import { t } from "@/lib/i18n";
import { Titled } from "@/components/ui/tooltip";
import { useBackendCompatibilityStore } from "@/lib/platform/backendCompatibilityStore";

/** 타이틀바의 백엔드 정합 칩 — 정상(current)일 땐 아무것도 그리지 않는다.
 *  skew를 조용히 겪으면 pane 이동·attach가 원인 불명으로 깨져 보인다는 것이
 *  2026-07-28 사건의 교훈: 상태를 보이게 하고 처방(재시작)을 tooltip에 싣는다. */
export function BackendSkewChip() {
	const compatibility = useBackendCompatibilityStore((s) => s.compatibility);
	if (!compatibility || compatibility.mode === "current") return null;

	const windowsPreview = compatibility.backend?.features.includes(
		"windows.desktop-preview-v1",
	);
	const skewOnly = compatibility.mode === "version-skew";
	const label = windowsPreview
		? t("workspace.windowsPreview.label")
		: skewOnly
			? t("workspace.backendSkew.outdated")
			: t("workspace.backendSkew.incompatible");
	const detail = windowsPreview
		? t("workspace.windowsPreview.detail")
		: t("workspace.backendSkew.detail", {
				front: compatibility.frontendBuildId,
				back: compatibility.backend?.buildId ?? "legacy",
			});

	return (
		<Titled title={detail}>
			<span
				data-nodrag
				className={
					skewOnly || windowsPreview
						? "rounded border border-status-warn/40 bg-status-warn/10 px-1.5 py-0.5 text-[10px] leading-none font-medium text-status-warn"
						: "rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] leading-none font-medium text-destructive"
				}

				aria-label={detail}>
				{label}
			</span>
		</Titled>
	);
}
