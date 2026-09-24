// 설정 › AI 제공업체 계정 페이지 — SettingsDialog(god-file)에서 추출.
//
// 시안 2496:59514 개편: 페이지를 감싸던 720px 카드를 걷어내고, 제공업체마다
// 헤더 한 줄(아이콘 · 이름 · 오른쪽 "계정 추가")과 hairline 구분선으로 나눈다.
// 헤더 오른쪽의 활성 계정 알약과 "계정 / 새 계정은 여기에 추가됩니다." 줄은
// 없앴다 — 어느 계정이 활성인지는 아래 목록의 "활성" 배지가 이미 말하고,
// 빈 상태 안내는 카드 본문과 같은 말을 두 번 하고 있었다.

import { openUrl } from "@tauri-apps/plugin-opener";
import {
	EllipsisVertical,
	ExternalLink,
	PenLine,
	Plus,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { Titled } from "@/components/ui/tooltip";
import { PageTitle } from "@/components/settings/PageTitle";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useAccountsPageState } from "@/components/settings/useAccountsPageState";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useRecentUsage } from "@/components/usage/useRecentUsage";
import { preflightAccountProfileCreation } from "@/lib/agents/accountProfilePreflight";
import { useAvailableProviders } from "@/lib/agents/agentInstalls";
import type { CredentialProfileRecovery } from "@/lib/agents/credentialSwitchRecovery";
import { useLoginIdentity } from "@/lib/agents/loginIdentity";
import { loginCmd, supportsAccounts } from "@/lib/agents/providers";
import { t } from "@/lib/i18n";
import { createAccountDir } from "@/lib/ipc";
import {
	providerAccountMeter,
	supportsProviderAccountMeter,
} from "@/lib/usage/accountUsageMeter";
import { usageDurationLabel } from "@/lib/usage/usageLabels";
import type { CodexMeter } from "@/lib/usage/usageMeter";
import { cn } from "@/lib/utils";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { openCommandTerminalOn } from "@/lib/workspace/dock/openCommandTerminal";
import { PROVIDERS, type Provider } from "@/types";

function AccountUsageSummary({
	meter,
}: {
	meter: CodexMeter | null | undefined;
}) {
	if (meter === undefined) {
		return (
			<span
				aria-hidden="true"
				className="w-40 shrink-0 text-right font-mono text-xs text-muted-foreground"
			>
				—
			</span>
		);
	}
	if (meter === null || meter.pct == null || meter.window == null) {
		return (
			<Titled title={t("usage.status.noneObserved")}>
				<span
					className="w-40 shrink-0 truncate text-right text-meta text-muted-foreground"
				>
					{t("usage.status.noneObserved")}
				</span>
			</Titled>
		);
	}
	const reset = usageDurationLabel(meter.resetLabel);
	const windowLabel =
		meter.window === "weekly"
			? t("usage.window.weekly")
			: t("usage.window.fiveHour");
	const resetLabel = reset
		? t("usage.reset.inlineShort", { reset })
		: null;
	return (
		<Titled title={[windowLabel, resetLabel, `${Math.round(meter.pct)}%`]
				.filter(Boolean)
				.join(" · ")}>
			<div
				data-slot="account-usage-summary"
				className="grid w-40 shrink-0 grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-2 text-right"
			>
				<span className="min-w-0 truncate text-meta text-muted-foreground">
					{windowLabel}
					{resetLabel ? ` · ${resetLabel}` : ""}
				</span>
				<span className="font-mono text-xs text-foreground tabular-nums">
					{Math.round(meter.pct)}%
				</span>
			</div>
		</Titled>
	);
}

/** 계정 카드 (시스템 기본값 / 관리 계정) — 클릭 시 활성 전환 */
function AccountCard({
	active,
	name,
	desc,
	usage,
	onSelect,
}: {
	active: boolean;
	name: string;
	desc: ReactNode;
	usage?: ReactNode;
	/** 없으면 안내 전용 카드 */
	onSelect?: () => void;
}) {
	const interactive = Boolean(onSelect);
	return (
		<Card
			onClick={onSelect}
			role={interactive ? "button" : undefined}
			tabIndex={interactive ? 0 : undefined}
			onKeyDown={
				interactive
					? (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								onSelect?.();
							}
						}
					: undefined
			}
			className={cn(
				"flex w-full flex-row items-center gap-3 rounded-[11px]",
				interactive && "cursor-pointer hover:bg-glass-tint-hover",
			)}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium text-foreground">{name}</span>
					{active && (
						<Badge size="sm" variant="secondary">
							{t("common.active")}
						</Badge>
					)}
				</div>
				<div className="truncate text-xs text-muted-foreground">{desc}</div>
			</div>
			{usage}
		</Card>
	);
}

/** 계정 목록 행 (관리 계정이 하나라도 있을 때) — 라디오로 활성 계정을 고른다 */
function AccountRow({
	active,
	name,
	desc,
	usage,
	onSelect,
	menu,
	editor,
}: {
	active: boolean;
	name: string;
	desc: ReactNode;
	usage?: ReactNode;
	onSelect: () => void;
	menu?: ReactNode;
	/** 이름 변경 중이면 제목 자리에 대신 렌더된다 */
	editor?: ReactNode;
}) {
	return (
		<div
			onClick={onSelect}
			className="flex w-full cursor-pointer items-start gap-3"
			role="radio"
			aria-checked={active}
		>
			{/* 두 줄 전체가 아니라 제목 줄(20px) 기준으로 라디오를 맞춘다 */}
			<span className="flex h-5 shrink-0 items-center">
				<span
					className={cn(
						"flex size-4 items-center justify-center rounded-full border bg-input/30 shadow-xs",
						active ? "border-primary" : "border-border",
					)}
				>
					{active && <span className="size-2 rounded-full bg-primary" />}
				</span>
			</span>
			<div className="flex min-w-px flex-1 flex-col justify-center gap-1.5">
				{/* 제목 줄 높이를 20px(text-sm leading-normal)로 고정한다.
				    이름 변경 인풋이 들어와도 행 높이가 변하지 않게 하기 위함. */}
				<div className="flex h-5 w-full items-center gap-2">
					{editor ?? (
						<>
							<span className="text-sm font-medium text-foreground">
								{name}
							</span>
							{active && (
								<Badge size="sm" variant="secondary">
									{t("common.active")}
								</Badge>
							)}
						</>
					)}
				</div>
				<div className="w-full truncate text-xs text-muted-foreground">
					{desc}
				</div>
			</div>
			{usage}
			{menu && (
				<span
					className="flex h-5 w-6 shrink-0 items-center justify-center"
					onClick={(e) => e.stopPropagation()}
				>
					{menu}
				</span>
			)}
		</div>
	);
}

function AccountIdentity({
	provider,
	dir,
	fallback,
}: {
	provider: Provider;
	dir: string | undefined;
	fallback: string;
}) {
	const identity = useLoginIdentity(provider, dir);
	const detail = [identity?.email, identity?.plan].filter(Boolean).join(" · ");
	return (
		<Titled title={dir ?? fallback}>
			<span className="font-mono text-[10px]">
				{detail || fallback}
			</span>
		</Titled>
	);
}

function AccountDescription({
	provider,
	dir,
	fallback,
	showIdentity,
}: {
	provider: Provider;
	dir: string | undefined;
	fallback: string;
	showIdentity: boolean;
}) {
	return showIdentity ? (
		<AccountIdentity provider={provider} dir={dir} fallback={fallback} />
	) : (
		fallback
	);
}

function AccountRecoveryNotice({
	recovery,
}: {
	recovery: CredentialProfileRecovery;
}) {
	return (
		<Alert icon={false} tone="warn" role="alert" className="grid gap-1">
			<div className="flex items-center gap-2 font-medium text-status-warn">
				<TriangleAlert className="size-4 shrink-0" />
				{t("settings.accounts.recovery.profileUntouched")}
			</div>
			<p>
				{t("settings.accounts.recovery.profileIncompatible", {
					name: recovery.accountName,
					path: recovery.profileDirectory,
					provider: PROVIDERS[recovery.provider].label,
				})}
			</p>
			<p className="text-muted-foreground">
				{t("settings.accounts.recovery.removeKeepsFiles")}{" "}
				<code>{t("settings.accounts.recovery.errorCode", { code: recovery.errorCode })}</code>
			</p>
		</Alert>
	);
}

/** AI 제공업체 계정 페이지 (디자인 상세) */
export function AccountsPage({
	onClose,
	recovery,
	showLoginIdentity = false,
	initialAddingProvider,
}: {
	onClose: () => void;
	recovery?: CredentialProfileRecovery;
	showLoginIdentity?: boolean;
	initialAddingProvider?: Provider;
}) {
	const {
		accounts,
		activeAccounts,
		addAccount,
		renameAccount,
		removeAccount,
		setActiveAccount,
		activeSpaceId,
		findAccountById,
	} = useAccountsPageState();
	const { u5 } = useRecentUsage(accounts);
	// 계정 분리를 지원하는 셋만 보여주면 설치해 둔 나머지 제공업체는 이 화면에
	// 아예 없는 것처럼 보인다 — 어떤 로그인으로 도는지 여기서 확인할 수 없으니
	// "인식이 안 된다"로 읽힌다. useAvailableProviders는 core 셋을 항상 포함하고
	// 나머지는 설치가 감지된 것만 주므로, 계정을 가진 제공업체가 감지 실패로
	// 사라지는 경우도 없다(계정을 가질 수 있는 셋이 곧 core 셋이다).
	const providers = useAvailableProviders();
	const [adding, setAdding] = useState<Provider | null>(
		recovery?.provider ??
			(initialAddingProvider && supportsAccounts(initialAddingProvider)
				? initialAddingProvider
				: null),
	);
	const [draft, setDraft] = useState(recovery?.suggestedName ?? "");
	// 오류는 제공업체를 달고 다닌다 — 폼이 닫힌 뒤(로그인 pane 생성 실패)에도
	// 보여야 하고, 다른 제공업체의 폼 아래에 남의 실패가 붙으면 안 된다.
	const [error, setError] = useState<{
		provider: Provider;
		message: string;
	} | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	/** Account id awaiting in-place removal confirmation (SOUL §6). */
	const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(
		null,
	);
	const nowSec = Date.now() / 1000;

	const accountUsageSummary = (
		provider: Provider,
		id: string | undefined,
		dir: string | undefined,
	): ReactNode => {
		if (!supportsProviderAccountMeter(provider)) return null;
		const meter = u5
			? providerAccountMeter(provider, u5, id, dir, nowSec)
			: undefined;
		return <AccountUsageSummary meter={meter} />;
	};

	const commitRename = () => {
		const name = renameDraft.trim();
		if (renaming && name) renameAccount(renaming, name);
		setRenaming(null);
	};

	const openLogin = (accountId: string) => {
		const acc = findAccountById(accountId);
		if (!acc) return;
		const api = getDockview(activeSpaceId);
		if (!api) return;
		openCommandTerminalOn(api, {
			title: t("common.loginWithName", { name: acc.name }),
			command: loginCmd(acc),
			closeOnSuccess: true,
		});
		onClose();
	};

	const add = async (provider: Provider) => {
		const name = draft.trim();
		// create_account_dir는 같은 이름에 같은 디렉터리를 되돌려 준다 — 왕복 중에
		// 한 번 더 누르면 같은 자격 증명을 가리키는 계정이 둘 생긴다.
		if (!name || submitting) return;
		setSubmitting(true);
		setError(null);
		try {
			await preflightAccountProfileCreation(provider);
			const dir = await createAccountDir(provider, name);
			const acc = addAccount({ provider, name, dir });
			setDraft("");
			setAdding(null);
			openLogin(acc.id);
		} catch (e) {
			setError({ provider, message: String(e) });
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<>
			<PageTitle
				title={t("settings.accounts.title")}
				desc={t("settings.accounts.description")}
			/>
			{recovery && <AccountRecoveryNotice recovery={recovery} />}
			<div className="flex w-full flex-col">
				{providers.map((provider, idx) => {
					const activeId = activeAccounts[provider];
					// 계정 분리는 검증된 per-process adapter가 있는 제공업체만 지원한다.
					// 나머지는 추가할 대상이 없으므로 버튼 대신 지금 무엇으로 도는지를
					// 알약으로 말한다(시안 2496:59572의 Gemini·OpenCode Go 자리).
					const manageable = supportsAccounts(provider);
					// 계정 목록을 그리는 섹션에서만 훑는다 — 설치된 CLI가 늘수록 매
					// 렌더에 버려질 필터가 섹션 수만큼 늘어난다.
					const pool = manageable
						? accounts.filter((a) => a.provider === provider)
						: [];
					return (
						<SettingsSection key={provider} first={idx === 0} className="gap-4">
							<div className="flex flex-col gap-3">
								{/* items-start: 설명이 두 줄로 늘어나도 버튼은 첫 줄에 붙어 있는다 */}
								<div className="flex w-full items-start gap-3">
									<div className="flex min-w-px flex-1 flex-col gap-1">
										<div className="flex items-center gap-1.5">
											{/* 20 beside a 14px medium title: the 24 read as a badge, not a
											    glyph (owner report 2026-09-14). */}
											<ProviderGlyph
												provider={provider}
												className="size-5 shrink-0"
											/>
											<span className="text-sm font-medium text-foreground">
												{PROVIDERS[provider].label}
											</span>
										</div>
										<p className="max-w-[600px] text-xs text-muted-foreground">
											{manageable
												? t("settings.accounts.separationSupported")
												: t("settings.accounts.separationUnsupported")}
										</p>
									</div>
									{manageable ? (
										<Button
											variant="outline"
											size="sm"
											className="h-8 shrink-0"
											onClick={() => {
												setDraft("");
												setError(null);
												setAdding((p) => (p === provider ? null : provider));
											}}
										>
											<Plus className="size-3" /> {t("settings.accounts.add")}
										</Button>
									) : (
										<span className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-[10.5px] text-muted-foreground">
											{t("common.systemDefault")}
										</span>
									)}
								</div>

								{adding === provider && (
									<div className="flex gap-2">
										<Input
											name="accountName"
											autoFocus
											value={draft}
											onChange={(e) => setDraft(e.target.value)}
											placeholder={t("settings.accounts.namePlaceholder")}
											className="h-8 text-xs"
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													// 한글 조합을 확정하는 Enter는 제출이 아니다
													if (e.nativeEvent.isComposing) return;
													add(provider);
												}
												if (e.key === "Escape") {
													// 위로 새면 설정 모달 자체가 닫힌다
													e.stopPropagation();
													setAdding(null);
												}
											}}
										/>
										<Button
											size="sm"
											className="h-8"
											disabled={submitting}
											onClick={() => add(provider)}
										>
											{t("common.add")}
										</Button>
									</div>
								)}

								{/* 실패한 섹션 안에 붙인다 — 페이지 맨 끝에 두면 어느 제공업체에서 난
								    오류인지 읽히지 않는다. 폼 밖에 두는 건 로그인 pane 생성이 실패하면
								    폼이 이미 닫힌 뒤에 오류가 오기 때문이다. */}
								{error?.provider === provider && (
									<p
										role="alert"
										className="text-xs break-all text-destructive"
									>
										{error.message}
									</p>
								)}
							</div>

							{manageable &&
								(pool.length === 0 ? (
									// 관리 계정이 없으면 고를 대상이 이것뿐이라 안내 카드로 둔다.
									<AccountCard
										active={!activeId}
										name={t("common.systemDefault")}
										usage={accountUsageSummary(provider, undefined, undefined)}
										desc={
											<AccountDescription
												provider={provider}
												dir={undefined}
												fallback={t("settings.accounts.systemLoginUntilManaged", { label: PROVIDERS[provider].label })}
												showIdentity={showLoginIdentity}
											/>
										}
									/>
								) : (
									<Card
										role="radiogroup"
										className="flex w-full flex-col gap-3 rounded-[11px]"
									>
										<AccountRow
											active={!activeId}
											name={t("common.systemDefault")}
											usage={accountUsageSummary(provider, undefined, undefined)}
											desc={
												<AccountDescription
													provider={provider}
													dir={undefined}
													fallback={t("settings.accounts.systemLoginLabel", {
														label: PROVIDERS[provider].label,
													})}
													showIdentity={showLoginIdentity}
												/>
											}
											onSelect={() => setActiveAccount(provider, undefined)}
										/>
										{pool.map((a) => (
											<Fragment key={a.id}>
												<Separator />
												{confirmingRemoveId === a.id ? (
													<InlineConfirmRow
														question={t("settings.accounts.removeConfirm", {
															name: a.name,
														})}
														confirmLabel={t(
															"settings.accounts.removeConfirmLabel",
														)}
														onConfirm={() => {
															removeAccount(a.id);
															setConfirmingRemoveId(null);
														}}
														onCancel={() => setConfirmingRemoveId(null)}
													/>
												) : (
												<AccountRow
													active={activeId === a.id}
													name={a.name}
													usage={accountUsageSummary(provider, a.id, a.dir)}
													desc={
														<AccountDescription
															provider={provider}
															dir={a.dir}
															fallback={a.dir}
															showIdentity={showLoginIdentity}
														/>
													}
													onSelect={() => setActiveAccount(provider, a.id)}
													editor={
														renaming === a.id ? (
															<Input
																autoFocus
																value={renameDraft}
																onChange={(e) => setRenameDraft(e.target.value)}
																onClick={(e) => e.stopPropagation()}
																onBlur={commitRename}
																onKeyDown={(e) => {
																	if (e.key === "Enter") commitRename();
																	if (e.key === "Escape") {
																		// 위로 새면 설정 모달 자체가 닫힌다
																		e.stopPropagation();
																		setRenaming(null);
																	}
																}}
																className="h-5 rounded-md px-1.5 py-0 text-sm"
															/>
														) : undefined
													}
													menu={
														<DropdownMenu>
															<DropdownMenuTrigger
																className="text-muted-foreground hover:text-foreground"
																title={t("settings.accounts.actionsMenu")}
															>
																<EllipsisVertical className="size-3.5" />
															</DropdownMenuTrigger>
															{/* 포털은 <html>의 .dark를 상속한다(useRootDarkClass).
															    w-auto: 기본값이 트리거(14px 아이콘) 폭을 상속해 항목이 줄바꿈된다. */}
															<DropdownMenuContent
																align="end"
																/* 닫힐 때 Radix가 포커스를 트리거로 되돌리면 이름 변경
																   인풋의 autoFocus를 뺏어가 blur가 아예 발생하지 않는다. */
																onCloseAutoFocus={(e) => e.preventDefault()}
																className="w-auto min-w-56"
															>
																<DropdownMenuItem
																	onSelect={() => {
																		setRenameDraft(a.name);
																		setRenaming(a.id);
																	}}
																>
																	<PenLine />
																	{t("settings.accounts.rename")}
																</DropdownMenuItem>
																{PROVIDERS[provider].accountUrl && (
																	<DropdownMenuItem
																		onSelect={() => {
																			const url =
																				PROVIDERS[provider].accountUrl;
																			if (url) openUrl(url).catch(() => {});
																		}}
																	>
																		<ExternalLink />
																		{t("settings.accounts.openAccountPage")}
																	</DropdownMenuItem>
																)}
																<DropdownMenuSeparator />
																<DropdownMenuItem
																	variant="destructive"
																	onSelect={() => setConfirmingRemoveId(a.id)}
																>
																	<Trash2 />
																	{t("settings.accounts.removeFromApp")}
																</DropdownMenuItem>
															</DropdownMenuContent>
														</DropdownMenu>
													}
												/>
												)}
											</Fragment>
										))}
									</Card>
								))}
						</SettingsSection>
					);
				})}
			</div>
		</>
	);
}
