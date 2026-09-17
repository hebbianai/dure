/**
 * 설정 → 모바일. Figma `dure-UI` 3326:87446(1/2) · 87594(2/2) · 87746(등록된 기기).
 *
 * # 무엇이 사라졌는지, 왜
 *
 * 이 자리에는 전송 계층의 조작반이 있었다 — 허브 켜기/끄기, 알릴 주소 고르기,
 * 릴레이 주소 입력과 등록 상태, 기기 이름 짓기, SSH 원격 로그인 자세와
 * `sshd_config` 처방, 페어링된 컴퓨터의 hmux 갱신. 그중 어느 것도 폰을 연결하려
 * 는 사람이 내려야 할 결정이 아니고, `hub_pairing_offer`가 이미 허브를 켜고
 * 릴레이에 등록될 때까지 기다린 뒤 제안을 돌려준다. 그래서 화면은 세 상태만
 * 남는다: 앱 받기 → 페어링 → 등록된 기기.
 *
 * # 왜 세 상태가 한 파일인지
 *
 * 셋이 같은 것 하나를 서로 다른 시점에서 말한다. 기기가 하나도 없으면
 * 마법사이고, 하나라도 있으면 목록이며, 목록에서 '다른 장치와 페어링'은 그
 * 마법사의 2단계로 바로 간다. 파일을 가르면 이 전이가 어느 쪽에도 없는 세
 * 번째 곳으로 밀려난다.
 */

import { ArrowRight, Plus, RotateCcw, Smartphone } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { useCallback, useEffect, useRef, useState } from "react";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import { useCopyFeedback } from "@/components/common/useCopyFeedback";
import { PageTitle } from "@/components/settings/PageTitle";
import { QrImage } from "@/components/settings/QrImage";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ErrorText } from "@/components/ui/error-text";
import { Segmented } from "@/components/ui/segmented";
import { t } from "@/lib/i18n";
import {
	type HubDeviceRevokeFailure,
	type PairedDevice,
	type QrMatrix,
	hubDeviceRevoke,
	hubDevices,
	hubPairingOffer,
	mobilePairingNetworks,
	mobilePairingQr,
} from "@/lib/ipc";
import {
	type MobilePlatform,
	MOBILE_INSTALL_URL,
	preferredPairingAddress,
	splitAroundPlaceholder,
} from "@/lib/settings/mobilePairing";

type Stage = "install" | "pair";

/**
 * 살아 있는 제안 하나.
 *
 * `hub_pairing_offer`는 부를 때마다 **기기를 하나 등록한다**. 그래서 제안은
 * 페이지가 들고, 2단계를 다시 열어도 같은 것을 그린다 — 단계마다 만들면 뒤로
 * 갔다 오는 것만으로 아무도 쓰지 않은 기기가 목록에 쌓인다.
 */
interface Offer {
	deviceId: string;
	matrix: QrMatrix;
	payload: string;
}

export function MobileConnectivityPage() {
	const [devices, setDevices] = useState<PairedDevice[]>([]);
	/** 목록을 한 번은 읽었는지. 읽기 전에 마법사를 그리면 등록된 폰이 있는
	 *  사람에게 화면이 한 번 깜빡인 뒤 목록으로 바뀐다. */
	const [loaded, setLoaded] = useState(false);
	/** 사람이 직접 연 단계. 없으면 기기 유무가 정한다. */
	const [stage, setStage] = useState<Stage | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [offer, setOffer] = useState<Offer | undefined>();
	const [offerError, setOfferError] = useState<string | undefined>();
	const [revokeFailure, setRevokeFailure] = useState<
		{ deviceId: string; failures: HubDeviceRevokeFailure[] } | undefined
	>();
	const [confirmForget, setConfirmForget] = useState(false);
	/** 지금 해지가 도는 기기. 서버들을 ssh 로 도는 동안 화면이 멈춘 것처럼
	 *  보이면 안 되고, 그 사이 다른 줄이 눌려서도 안 된다. */
	const [revoking, setRevoking] = useState<string | undefined>();
	const alive = useRef(true);
	/**
	 * 제안의 사본과 "만드는 중" 표시.
	 *
	 * `mintOffer`가 상태를 **의존성으로** 읽으면 제안이 바뀔 때마다 새 함수가
	 * 되고, 그것을 실행하는 2단계의 effect가 다시 돈다 — 코드 재생성 한 번이
	 * 기기 두 개를 등록했다. 신원이 고정된 함수가 ref로 현재 값을 본다.
	 */
	const offerRef = useRef<Offer | undefined>(undefined);
	const minting = useRef(false);

	const load = useCallback(async () => {
		try {
			const paired = await hubDevices();
			if (!alive.current) return paired;
			setDevices(paired);
			setLoaded(true);
			return paired;
		} catch (cause) {
			if (alive.current) {
				setError(String(cause));
				setLoaded(true);
			}
			return undefined;
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		void load();
		return () => {
			alive.current = false;
		};
	}, [load]);

	/**
	 * 제안 하나를 만든다.
	 *
	 * `replace`가 참이면 앞서 만든 제안의 기기를 먼저 지운다 — 코드 재생성은
	 * 새 기기를 하나 더 등록하는 일이고, 지우지 않으면 아무도 쓰지 않은 기기가
	 * 목록에 남는다. 이미 살아 있는 제안이 있고 바꾸라고 하지 않았으면 아무
	 * 일도 하지 않는다.
	 */
	const mintOffer = useCallback(async (replace = false) => {
		if (minting.current) return;
		if (offerRef.current && !replace) return;
		minting.current = true;
		setOfferError(undefined);
		const previous = offerRef.current?.deviceId;
		setOffer(undefined);
		try {
			if (previous) {
				const cleanup = await hubDeviceRevoke(previous);
				if (!cleanup.revoked && cleanup.failures.length > 0) {
					if (alive.current) {
						setOffer(offerRef.current);
						setRevokeFailure({
							deviceId: previous,
							failures: cleanup.failures,
						});
					}
					return;
				}
				setRevokeFailure((failure) =>
					failure?.deviceId === previous ? undefined : failure,
				);
			}
			// Retire this identity only after cleanup succeeds, so retries target it.
			offerRef.current = undefined;
			const networks = await mobilePairingNetworks();
			if (!alive.current) return;
			const made = await hubPairingOffer(
				t("settings.hubRelay.defaultDeviceName"),
				preferredPairingAddress(networks),
				// 빈 문자열이면 백엔드가 기본 릴레이를 쓴다. 고를 것이 하나뿐이라
				// 화면에서 묻지 않는다.
				"",
			);
			const matrix = await mobilePairingQr(made.payload);
			if (!alive.current) return;
			offerRef.current = { deviceId: made.device_id, matrix, payload: made.payload };
			setOffer(offerRef.current);
		} catch (cause) {
			if (alive.current) {
				setOffer(offerRef.current);
				setOfferError(String(cause));
			}
		} finally {
			minting.current = false;
		}
	}, []);

	/**
	 * 기기 하나를 지운다.
	 *
	 * 허브 토큰만 지우는 일이 아니다 — 같은 짝짓기가 서버마다 심어 둔 강제 명령
	 * 키를 ssh 로 하나씩 거둬들이므로 서버 수만큼 시간이 걸리고, 서버 하나가
	 * 꺼져 있으면 실패한다. 그래서 도는 동안 그 줄을 잠그고, hmux가 돌려준
	 * 서버 이름과 원인은 재시도 및 명시적인 기록 포기 선택과 함께 보여준다.
	 */
	const revoke = (deviceId: string, forgetUnreachable = false) => {
		if (revoking) return;
		setRevoking(deviceId);
		setError(undefined);
		void (async () => {
			try {
				const outcome = await hubDeviceRevoke(deviceId, forgetUnreachable);
				if (alive.current) {
					if (
						!forgetUnreachable &&
						!outcome.revoked &&
						outcome.failures.length > 0
					) {
						setRevokeFailure({ deviceId, failures: outcome.failures });
					} else {
						setRevokeFailure(undefined);
						setConfirmForget(false);
					}
				}
			} catch (cause) {
				if (alive.current) setError(String(cause));
			}
			await load();
			if (alive.current) setRevoking(undefined);
		})();
	};

	const view: Stage | "devices" = stage ?? (devices.length > 0 ? "devices" : "install");

	return (
		<>
			<PageTitle title={t("settings.mobilePairing.title")} desc={t("settings.mobile.subtitle")} />
			{error && <ErrorText className="text-sm">{error}</ErrorText>}
			{revokeFailure && (
				<Alert icon={false} tone="warn" role="alert" className="grid gap-2 text-sm">
					<div className="grid gap-1">
						<p className="font-medium">
							{t("settings.mobile.devices.revokeFailed")}
						</p>
						<p className="text-muted-foreground">
							{t("settings.mobile.devices.recordKept")}
						</p>
					</div>
					<ul className="grid list-disc gap-1 pl-5 font-mono text-xs break-words">
						{revokeFailure.failures.map((failure) => (
							<li key={`${failure.name}:${failure.failure}`}>
								{failure.name}: {failure.failure}
							</li>
						))}
					</ul>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={revoking !== undefined}
							onClick={() => revoke(revokeFailure.deviceId)}
						>
							{t("common.retry")}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={revoking !== undefined}
							onClick={() => setConfirmForget(true)}
						>
							{t("settings.mobile.devices.forget")}
						</Button>
					</div>
				</Alert>
			)}
			{!loaded && view !== "pair" ? null : view === "devices" ? (
				<DeviceList
					devices={devices}
					onAdd={() => setStage("pair")}
					onRevoke={revoke}
					revoking={revoking}
				/>
			) : view === "install" ? (
				<InstallStep onContinue={() => setStage("pair")} />
			) : (
				<PairStep
					offer={offer}
					error={offerError}
					mint={mintOffer}
					onBack={() => setStage(devices.length > 0 ? undefined : "install")}
					onDone={async () => {
						if (!(await load())) return;
						// The user finishes after confirming the connection on the phone.
						offerRef.current = undefined;
						setOffer(undefined);
						setStage(undefined);
					}}
				/>
			)}
			<Dialog
				open={confirmForget}
				onOpenChange={(open) => {
					if (!open && revoking === undefined) setConfirmForget(false);
				}}
			>
				<DialogContent showCloseButton={false}>
					<DialogHeader>
						<DialogTitle>
							{t("settings.mobile.devices.forgetTitle")}
						</DialogTitle>
						<DialogDescription>
							{t("settings.mobile.devices.forgetDescription")}
						</DialogDescription>
					</DialogHeader>
					<DialogActionFooter
						onCancel={() => setConfirmForget(false)}
						confirmLabel={t("settings.mobile.devices.forgetConfirm")}
						busyLabel={t("settings.mobile.devices.revoking")}
						busy={revoking !== undefined}
						variant="destructive"
						onConfirm={() => {
							if (revokeFailure) revoke(revokeFailure.deviceId, true);
						}}
					/>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** 시안의 "1/2" — 단계 수를 세는 줄. */
function StepCounter({ index, total }: { index: number; total: number }) {
	return (
		<span className="text-xs font-medium text-muted-foreground">
			{t("settings.mobile.step.counter", { index, total })}
		</span>
	);
}

/** 번호가 붙은 한 단계. 원은 24px, 본문은 15/22 — 시안의 값 그대로. */
function Step({ index, children }: { index: number; children: React.ReactNode }) {
	return (
		<li className="flex w-full items-start gap-3.5">
			<span className="grid size-6 shrink-0 place-items-center rounded-full border border-border text-[12.5px] font-semibold text-foreground shadow-xs">
				{index}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-0.5 text-[15px] leading-[22px] text-foreground">
				{children}
			</div>
		</li>
	);
}

/** The QR panel; both steps draw it in the same place at the same size. Its
 *  top edge stands where the first step's text starts (the 2px the text sits
 *  under its circle), so only that top offset is added — centred in a 272px
 *  box it began 26px below the text (owner call 2026-09-10). */
function QrPanel({ matrix, label }: { matrix: QrMatrix | undefined; label: string }) {
	return (
		<div className="shrink-0 pt-0.5">
			{matrix ? (
				<QrImage matrix={matrix} label={label} />
			) : (
				<div className="grid size-[220px] place-items-center">
					<span className="text-xs text-muted-foreground">{t("settings.mobile.qr.building")}</span>
				</div>
			)}
		</div>
	);
}

/** 1/2 — 앱 받기. QR은 고른 플랫폼의 설치 페이지를 나른다. */
function InstallStep({ onContinue }: { onContinue: () => void }) {
	const [platform, setPlatform] = useState<MobilePlatform>("ios");
	const [matrix, setMatrix] = useState<QrMatrix | undefined>();
	const { status: copyStatus, copy } = useCopyFeedback({
		resetMs: 2000,
		write: (text) => navigator.clipboard.writeText(text),
	});
	const url = MOBILE_INSTALL_URL[platform];

	useEffect(() => {
		let alive = true;
		setMatrix(undefined);
		void (async () => {
			try {
				const grid = await mobilePairingQr(url);
				if (alive) setMatrix(grid);
			} catch {
				// QR을 못 그려도 링크 복사는 남는다. 이 자리에 오류 문장을 세우면
				// 실제로 할 수 있는 일(복사)이 경고 아래로 밀린다.
			}
		})();
		return () => {
			alive = false;
		};
	}, [url]);

	const sentence = splitAroundPlaceholder(t("settings.mobile.install.orSend"));

	return (
		<>
			<div className="flex flex-col gap-2.5 pt-6">
				<StepCounter index={1} total={2} />
				<h3 className="text-xl leading-[26px] font-semibold text-foreground">
					{t("settings.mobile.install.heading")}
				</h3>
			</div>
			<div className="flex items-start gap-10 pt-4">
				<ol className="flex min-w-0 flex-1 list-none flex-col gap-6">
					<Step index={1}>
						<p>{t("settings.mobile.install.step1")}</p>
						<div className="flex flex-col gap-2">
							<Segmented<MobilePlatform>
								variant="pills"
								// 시안의 트랙은 136px — 두 라벨만큼이다. 폭을 내용에 맞추지
								// 않으면 flex 열의 stretch가 트랙을 단계 폭까지 늘린다.
								className="w-fit"
								value={platform}
								onChange={setPlatform}
								options={[
									{ value: "ios", label: "iOS" },
									{ value: "android", label: "Android" },
								]}
							/>
							<p className="text-xs text-muted-foreground">
								{sentence.before}
								<button
									type="button"
									onClick={() => void copy(url)}
									className="font-medium text-muted-foreground underline underline-offset-4"
								>
									{copyStatus === "copied"
										? t("settings.mobilePairing.copied")
										: t("settings.mobile.install.copyLink")}
								</button>
								{sentence.after}
							</p>
						</div>
					</Step>
					<Step index={2}>
						<p>{t("settings.mobile.install.step2")}</p>
					</Step>
				</ol>
				<QrPanel matrix={matrix} label={t("settings.mobile.install.qrAlt")} />
			</div>
			<div className="mt-auto flex justify-end pt-8">
				<Button size="lg" className="h-10 px-8" onClick={onContinue}>
					{t("settings.mobile.install.pairCta")}
					<ArrowRight data-icon="inline-end" />
				</Button>
			</div>
		</>
	);
}

/** 2/2 — 페어링 코드. 제안은 페이지가 들고, 이 단계는 그것을 그린다. */
function PairStep({
	offer,
	error,
	mint,
	onBack,
	onDone,
}: {
	offer: Offer | undefined;
	error: string | undefined;
	mint: (replace?: boolean) => Promise<void>;
	onBack: () => void;
	onDone: () => void;
}) {
	const { status: copyStatus, copy } = useCopyFeedback();
	// 없을 때만 만든다 — 뒤로 갔다 돌아온 것은 새 코드를 달라는 뜻이 아니다.
	useEffect(() => {
		void mint();
	}, [mint]);

	// An issued QR already has a registered credential. Only the phone can
	// confirm that it saved the connection; device count cannot prove that.

	return (
		<>
			<div className="flex flex-col gap-2.5 pt-6">
				<StepCounter index={2} total={2} />
				<h3 className="text-xl leading-[26px] font-semibold text-foreground">
					{t("settings.mobile.pair.heading")}
				</h3>
				<p className="text-sm text-muted-foreground">{t("settings.mobile.pair.desc")}</p>
			</div>
			<div className="flex items-start gap-10 pt-4">
				<ol className="flex min-w-0 flex-1 list-none flex-col gap-6">
					<Step index={1}>
						<p>{t("settings.mobile.pair.step1")}</p>
					</Step>
					<Step index={2}>
						<p className="flex flex-wrap items-center gap-1.5">
							<span className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
								{t("settings.mobile.pair.scanButton")}
							</span>
							{t("settings.mobile.pair.step2")}
						</p>
					</Step>
					<Step index={3}>
						<p>{t("settings.mobile.pair.step3")}</p>
					</Step>
					{error && <ErrorText className="text-sm">{error}</ErrorText>}
				</ol>
				<div className="flex shrink-0 flex-col items-center gap-3">
					<QrPanel matrix={offer?.matrix} label={t("settings.mobile.pair.qrAlt")} />
					<Button
						variant="outline"
						size="sm"
						disabled={!offer}
						onClick={() => {
							if (offer) void copy(offer.payload);
						}}
					>
						{copyStatus === "copied"
							? t("settings.mobilePairing.copied")
							: t("settings.mobilePairing.copyCode")}
					</Button>
					{copyStatus === "failed" && (
						<ErrorText>{t("common.copyToClipboardFailed")}</ErrorText>
					)}
					<button
						type="button"
						onClick={() => void mint(true)}
						className="flex items-center gap-1.5 text-xs text-muted-foreground"
					>
						<RotateCcw className="size-3.5" />
						{t("settings.mobile.pair.regenerate")}
					</button>
				</div>
			</div>
			<div className="mt-auto flex justify-between pt-8">
				<Button variant="ghost" size="lg" onClick={onBack}>
					<ArrowRight data-icon="inline-start" className="rotate-180" />
					{t("common.back")}
				</Button>
				<Button size="lg" disabled={!offer} onClick={onDone}>
					{t("common.done")}
				</Button>
			</div>
		</>
	);
}

/** 등록된 기기. 한 줄에 하나, 마지막 줄만 아래 테두리가 없다. */
function DeviceList({
	devices,
	onAdd,
	onRevoke,
	revoking,
}: {
	devices: readonly PairedDevice[];
	onAdd: () => void;
	onRevoke: (deviceId: string) => void;
	revoking: string | undefined;
}) {
	return (
		<>
			<div className="flex items-center justify-between pt-6">
				<h3 className="text-sm font-medium text-foreground">
					{t("settings.mobile.devices.title")}
				</h3>
				<Button variant="outline" onClick={onAdd}>
					<Plus data-icon="inline-start" />
					{t("settings.mobile.devices.add")}
				</Button>
			</div>
			<ul className="flex list-none flex-col rounded-xl border border-border">
				{devices.map((device) => (
					<li
						key={device.device_id}
						className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0"
					>
						<Smartphone className="size-4 shrink-0 text-muted-foreground" />
						<div className="flex min-w-0 flex-1 flex-col gap-1">
							<span className="truncate text-sm font-medium text-foreground">
								{device.label}
							</span>
							{/* 시안은 여기에 "iOS 18.4 · 방금 연결"을 적는다. 허브는 기기의
							    플랫폼도 마지막 연결 시각도 기록하지 않으므로, 지어내는 대신
							    실제로 가진 사실 — 그 기기의 id — 를 적는다. */}
							<span data-selectable className="truncate font-mono text-xs text-muted-foreground">
								{device.device_id}
							</span>
						</div>
						<button
							type="button"
							onClick={() => onRevoke(device.device_id)}
							disabled={revoking !== undefined}
							className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50 disabled:hover:no-underline"
						>
							{revoking === device.device_id
								? t("settings.mobile.devices.revoking")
								: t("settings.mobile.devices.revoke")}
						</button>
					</li>
				))}
			</ul>
		</>
	);
}
