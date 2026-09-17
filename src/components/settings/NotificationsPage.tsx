import { BellRing, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { PageTitle } from "@/components/settings/PageTitle";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { t } from "@/lib/i18n";
import {
	type NativeNotificationStatus,
	type NotificationDispatchReceipt,
	notificationBackendFailure,
	notificationOpenSettings,
	notificationRequestAuthorization,
	notificationStatus,
} from "@/lib/ipc/notifications";
import { systemNotify } from "@/lib/settings/notify";
import {
	NOTIFICATION_SOUND_NONE,
	NOTIFICATION_SOUND_SYSTEM,
	normalizedNotificationSoundPreference,
} from "@/lib/settings/notifyPrefs";
import { showErrorToast, showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/workspace/desktop/desktopPlatform";
import { DEFAULT_NOTIFY_PREFS, type NotifyPrefs, useStore } from "@/store";

const SOUNDS = [
	"Ping",
	"Glass",
	"Hero",
	"Pop",
	"Funk",
	"Purr",
	"Sosumi",
	"Submarine",
	"Tink",
];

/** 스위치 한 줄 (시안 2524:70578) — 제목·설명 왼쪽, 스위치 오른쪽.
 *
 *  줄 전체가 `<label>`이라 설명 문장을 눌러도 토글된다. 시안이 행을 통째로
 *  버튼으로 그린 의도가 이것인데, 스위치(Radix가 `<button>`으로 렌더한다)를
 *  버튼 안에 넣으면 중첩 인터랙티브가 되어 무효 HTML이다. `<button>`은 label이
 *  가리킬 수 있는 요소라, label로 감싸면 중첩 없이 같은 결과가 난다. */
function SwitchRow({
	title,
	desc,
	checked,
	onCheckedChange,
	className,
}: {
	title: string;
	desc: string;
	checked: boolean;
	onCheckedChange: (value: boolean) => void;
	className?: string;
}) {
	const id = useId();
	return (
		<label
			htmlFor={id}
			className={cn("flex w-full cursor-pointer items-start gap-3", className)}
		>
			<span className="flex min-w-px flex-1 flex-col gap-1.5">
				{/* pt-[3px]: 제목이 leading-none이라 그대로 두면 스위치보다 3px 높이 뜬다 */}
				<span className="pt-[3px] text-sm leading-none font-medium text-foreground">
					{title}
				</span>
				<span className="text-xs text-muted-foreground">{desc}</span>
			</span>
			<Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
		</label>
	);
}

/** 알림 (시안 2524:70567): Agent 상태·터미널 벨·알림음·집중 억제 — 전부 실배선.
 *
 *  개편: 페이지를 감싸던 720px 카드를 걷어내고 계정·프로바이더 페이지와 같은
 *  hairline 리듬으로 맞춘다. 설정 창 안에서 세 페이지가 같은 골격을 쓴다. */
export function NotificationsPage() {
	const raw = useStore((s) => s.notifyPrefs);
	const set = useStore((s) => s.setNotifyPrefs);
	const np: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, ...raw };
	const [nativeStatus, setNativeStatus] =
		useState<NativeNotificationStatus | null>(null);
	const [lastReceipt, setLastReceipt] =
		useState<NotificationDispatchReceipt | null>(null);
	const [busy, setBusy] = useState<"permission" | "test" | null>(null);
	const loadStatus = useCallback(() => {
		void notificationStatus()
			.then(setNativeStatus)
			.catch((error) => setNativeStatus(notificationBackendFailure(error)));
	}, []);
	useEffect(() => {
		loadStatus();
		window.addEventListener("focus", loadStatus);
		return () => window.removeEventListener("focus", loadStatus);
	}, [loadStatus]);

	const authorizationLabel = !nativeStatus
		? t("common.checking")
		: nativeStatus.authorization === "authorized"
			? t("settings.permissions.allowed")
			: nativeStatus.authorization === "denied"
				? t("settings.permissions.notAllowed")
				: nativeStatus.authorization === "not-determined"
					? t("settings.notifications.permission.notRequestedBadge")
					: t("settings.permissions.manualCheck");
	const authorizationVariant =
		nativeStatus?.authorization === "authorized"
			? "default"
			: nativeStatus?.authorization === "denied"
				? "destructive"
				: "secondary";
	const senderDescription =
		!nativeStatus
			? t("settings.notifications.status.checking")
			: nativeStatus.sender === "dure-app"
			? t("settings.notifications.status.appIdentity")
			: nativeStatus.sender === "dure-installed-bridge"
				? t("settings.notifications.status.devBuildIdentity")
				: t("settings.notifications.status.senderUnknown");
	const deliveryDetail = lastReceipt?.detail ?? nativeStatus?.detail;
	const isMac = isMacPlatform();
	const hasPersistentPresentation =
		isMac &&
		nativeStatus?.authorization === "authorized" &&
		nativeStatus.presentation === "persistent";
	const shouldRecommendPersistent =
		isMac &&
		nativeStatus !== null &&
		!hasPersistentPresentation &&
		(nativeStatus.authorization === "authorized" ||
			nativeStatus.sender === "dure-installed-bridge");
	const presentationDescription =
		hasPersistentPresentation
			? t("settings.notifications.status.persistent")
			: shouldRecommendPersistent
				? t("settings.notifications.status.temporary")
				: null;
	const deliveryReason = lastReceipt?.accepted
		? null
		: lastReceipt?.reason === "permission-denied"
			? t("settings.notifications.status.deliveryDisabled")
			: lastReceipt?.reason === "permission-not-requested"
				? t("settings.notifications.status.notRequested")
				: lastReceipt?.reason === "duplicate-event"
					? t("settings.notifications.status.alreadyHandled")
					: lastReceipt?.reason === "dispatch-failed"
						? t("settings.notifications.status.osRequestFailed")
						: lastReceipt?.reason === "backend-error"
							? t("settings.notifications.status.backendUnreachable")
							: null;

	const requestAuthorization = async () => {
		setBusy("permission");
		try {
			const status = await notificationRequestAuthorization();
			setNativeStatus(status);
			if (status.authorization === "authorized") {
				showToast(t("settings.notifications.permission.allowedToast"));
			} else if (status.authorization === "denied") {
				showErrorToast(t("settings.notifications.permission.deniedToast"));
			}
		} catch (error) {
			setNativeStatus(notificationBackendFailure(error));
			showErrorToast(
				t("settings.notifications.permission.checkFailed", {
					error: String(error),
				}),
			);
		} finally {
			setBusy(null);
		}
	};

	const sendTest = async () => {
		setBusy("test");
		try {
			if (nativeStatus?.authorization === "not-determined") {
				const status = await notificationRequestAuthorization();
				setNativeStatus(status);
				if (status.authorization !== "authorized") {
					showErrorToast(t("settings.notifications.test.allowFirst"));
					return;
				}
			}
			const receipt = await systemNotify(
				t("settings.notifications.test.title"),
				t("settings.notifications.test.body"),
			);
			setLastReceipt(receipt);
			setNativeStatus(receipt);
			if (receipt.accepted) {
				showToast(t("settings.notifications.test.osAccepted"), 5000);
			} else if (receipt.reason === "permission-denied") {
				showErrorToast(t("settings.notifications.test.macosDisabled"));
			} else if (receipt.reason === "permission-not-requested") {
				showErrorToast(t("settings.notifications.test.allowFirst"));
			} else {
				showErrorToast(t("settings.notifications.test.deliverFailed"));
			}
		} catch (error) {
			showErrorToast(
				t("settings.notifications.test.deliverFailedWithError", {
					error: String(error),
				}),
			);
		} finally {
			setBusy(null);
		}
	};
	return (
		<>
			<PageTitle
				title={t("settings.notifications.title")}
				desc={t("settings.notifications.description")}
			/>
			<div className="flex w-full flex-col">
				{/* 시안 2524:70578 — 제목에서 32px, 구분선까지 24px */}
				<SwitchRow
					className="pt-2 pb-6"
					title={t("settings.notifications.enable.title")}
					desc={t("settings.notifications.enable.desc")}
					checked={np.enabled}
					onCheckedChange={(v) => set({ enabled: v })}
				/>

				<div className="flex w-full flex-col gap-6 border-t border-border py-6">
					<SwitchRow
						title={t("settings.notifications.event.taskComplete.title")}
						desc={t("settings.notifications.event.taskComplete.desc")}
						checked={np.agentDone}
						onCheckedChange={(v) => set({ agentDone: v })}
					/>
					{/* 시안에 없지만 지우지 않는다 — 이 둘은 agentAttentionNotifier가
					    실제로 읽는 게이트라, 스위치만 빼면 알림은 계속 오는데 끄는
					    길이 사라진다(둘 다 기본값 true). */}
					<SwitchRow
						title={t("settings.notifications.event.approvalRequired.title")}
						desc={t("settings.notifications.event.approvalRequired.desc")}
						checked={np.approvalRequired}
						onCheckedChange={(v) => set({ approvalRequired: v })}
					/>
					<SwitchRow
						title={t("settings.notifications.event.sessionExited.title")}
						desc={t("settings.notifications.event.sessionExited.desc")}
						checked={np.agentExited}
						onCheckedChange={(v) => set({ agentExited: v })}
					/>
					<SwitchRow
						title={t("settings.notifications.event.terminalBell.title")}
						desc={t("settings.notifications.event.terminalBell.desc")}
						checked={np.terminalBell}
						onCheckedChange={(v) => set({ terminalBell: v })}
					/>
				</div>

				<div className="flex w-full flex-col gap-3 border-t border-border py-6">
					<div className="flex w-full flex-col gap-1.5">
						{/* 스위치가 없는 행 — SwitchRow의 스위치 정렬 보정(pt-[3px])을
						    복사해 오면 제목만 3px 내려앉는다. */}
						<span className="text-sm leading-none font-medium text-foreground">
							{t("settings.notifications.sound.title")}
						</span>
						<span className="text-xs text-muted-foreground">
							{t("settings.notifications.sound.desc")}
						</span>
					</div>
					<SelectField
						value={normalizedNotificationSoundPreference(np.sound)}
						onValueChange={(sound) => set({ sound })}
						className="w-[420px]"
					>
						<SelectOption value={NOTIFICATION_SOUND_SYSTEM}>
							{t("common.systemDefault")}
						</SelectOption>
						<SelectOption value={NOTIFICATION_SOUND_NONE}>
							{t("settings.notifications.sound.none")}
						</SelectOption>
						{SOUNDS.map((sound) => (
							<SelectOption key={sound} value={sound}>
								{sound}
							</SelectOption>
						))}
					</SelectField>
				</div>

				<SwitchRow
					className="border-t border-border py-6"
					title={t("settings.notifications.suppressFocused.title")}
					desc={t("settings.notifications.suppressFocused.desc")}
					checked={np.suppressWhenVisible}
					onCheckedChange={(v) => set({ suppressWhenVisible: v })}
				/>

				{/* Not in the mockup. Kept because when the macOS permission is
				    not-determined, this block's "request permission" is the only way
				    inside the app to turn notifications on, and this is also the only
				    spot that reports a denied state. Only the card wrapper was removed;
				    it moved down as the last section in the same rhythm. */}
				<div className="flex w-full flex-col gap-3 border-t border-border py-6">
					<div className="flex items-start gap-3">
						<BellRing className="mt-0.5 size-4 shrink-0 text-foreground" />
						<div className="flex min-w-0 flex-1 flex-col gap-1.5">
							<div className="flex items-center gap-2">
								<span className="text-sm font-medium text-foreground">
									{t("settings.notifications.status.title")}
								</span>
								<Badge variant={authorizationVariant}>
									{authorizationLabel}
								</Badge>
							</div>
							<span className="text-xs text-muted-foreground">
								{senderDescription}
							</span>
							{presentationDescription && (
								<span className="text-xs text-foreground">
									{presentationDescription}
								</span>
							)}
							{lastReceipt && (
								<span
									className={
										lastReceipt.accepted
											? "text-xs text-primary"
											: "text-xs text-destructive"
									}
								>
									{lastReceipt.accepted
										? t("settings.notifications.test.lastAccepted")
										: t("settings.notifications.test.lastNotDelivered")}
								</span>
							)}
							{deliveryReason && (
								<span className="text-[11px] text-destructive">
									{deliveryReason}
								</span>
							)}
							{deliveryDetail && (
								<span className="text-[11px] text-muted-foreground">
									{deliveryDetail}
								</span>
							)}
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{nativeStatus?.authorization === "not-determined" &&
							nativeStatus.sender === "dure-app" && (
								<Button
									variant="outline"
									size="sm"
									disabled={busy !== null}
									onClick={() => void requestAuthorization()}
								>
									{busy === "permission" ? t("settings.permissions.requesting") : t("settings.permissions.request")}
								</Button>
							)}
						<Button
							variant="outline"
							size="sm"
							disabled={busy !== null}
							onClick={() => void sendTest()}
						>
							{busy === "test" ? t("settings.notifications.test.testing") : t("settings.notifications.test.send")}
						</Button>
						<Button variant="ghost" size="sm" onClick={loadStatus}>
							<RefreshCw className="size-3" /> {t("common.refresh")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								void notificationOpenSettings().catch((error) => {
									showErrorToast(
										t("settings.notifications.openSettingsFailed", {
											error: String(error),
										}),
									);
								});
							}}
						>
							<ExternalLink className="size-3" />{" "}
							{shouldRecommendPersistent
								? t("settings.notifications.status.openPersistentSettings")
								: t("common.openSettings")}
						</Button>
					</div>
					<span className="text-[11px] text-muted-foreground">
						{t("settings.notifications.status.acceptedCaveat")}
					</span>
				</div>
			</div>
		</>
	);
}
