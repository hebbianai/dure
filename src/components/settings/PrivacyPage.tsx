// 설정 › 개인정보 및 텔레메트리 페이지 — SettingsDialog의 InfoPage 자리를 대신한다.
//
// 시안 2525:74656의 골격(제목 + hairline으로 갈린 행들)은 그대로 따르되, 그
// 시안이 그린 두 컨트롤은 넣지 않는다. 이 페이지에서만은 그 판단이 특히
// 중요하다: 켜고 끌 것이 없는데 스위치를 두면, 사용자는 그걸 끄고 "이제 안
// 보내는구나"라고 믿게 된다. 개인정보 화면에서 아무것도 제어하지 않는
// 컨트롤은 없는 것보다 나쁘다. 그래서 컨트롤 자리에는 지금 상태를 말하는
// 알약을 둔다 — 계정 페이지가 계정 분리를 못 하는 제공업체에 "시스템 기본값"
// 알약을 두는 것과 같은 어휘다.
import { FlatRow } from "@/components/settings/FlatRow";
import { PageTitle } from "@/components/settings/PageTitle";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** 고를 것이 없는 자리에서 지금 상태만 말하는 알약. */
function StatePill({ children, tone }: { children: React.ReactNode; tone?: "good" }) {
	return (
		<span
			className={cn(
				"shrink-0 rounded-full border px-2.5 py-0.5 text-[10.5px]",
				tone === "good"
					? "border-status-run/40 text-status-run"
					: "border-border text-muted-foreground",
			)}
		>
			{children}
		</span>
	);
}

export function PrivacyPage() {
	return (
		<>
			<PageTitle
				title={t("settings.privacy.title")}
				desc={t("settings.privacy.description")}
			/>
			<div className="flex w-full flex-col">
				<section className="flex w-full flex-col pt-2 pb-6">
					<FlatRow
						title={t("settings.privacy.usageData.title")}
						desc={t("settings.privacy.usageData.desc")}
					>
						<StatePill tone="good">{t("settings.privacy.usageData.notCollected")}</StatePill>
					</FlatRow>
				</section>

				<section className="flex w-full flex-col border-t border-border py-6">
					<FlatRow
						title={t("settings.privacy.diagnostics.title")}
						desc={t("settings.privacy.diagnostics.desc")}
					>
						<StatePill>{t("settings.privacy.diagnostics.onlyOnYourAction")}</StatePill>
					</FlatRow>
				</section>

				<section className="flex w-full flex-col border-t border-border py-6">
					<FlatRow
						title={t("settings.privacy.credentials.title")}
						desc={t("settings.privacy.credentials.desc")}
					>
						<StatePill>{t("settings.privacy.credentials.deviceOnly")}</StatePill>
					</FlatRow>
				</section>

				<section className="flex w-full flex-col border-t border-border py-6">
					<FlatRow
						title={t("settings.privacy.feedback.title")}
						desc={t("settings.privacy.feedback.desc")}
					>
						<StatePill>{t("settings.privacy.feedback.onlyWhenSent")}</StatePill>
					</FlatRow>
				</section>
			</div>
		</>
	);
}
