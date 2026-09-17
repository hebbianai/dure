import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Titled } from "@/components/ui/tooltip";
import {
	AccountMenuLabel,
	type AccountMenuLimit,
} from "@/components/usage/AccountMenuLabel";
import { useLoginIdentity } from "@/lib/agents/loginIdentity";
import { providerLoginCmd } from "@/lib/agents/providers";
import { t } from "@/lib/i18n";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { openCommandTerminalOn } from "@/lib/workspace/dock/openCommandTerminal";
import { useStore } from "@/store";
import { type AccountProfile, PROVIDERS, type Provider } from "@/types";

export interface UsagePopoverAccount {
	id: string | undefined;
	dir: string | undefined;
}

export type UsageAccountLimit = AccountMenuLimit;

interface AccountChoice extends UsagePopoverAccount {
	name: string;
	account: AccountProfile | undefined;
}

function AccountItem({
	provider,
	profile,
	limit,
	onSelect,
	onLogin,
}: {
	provider: Provider;
	profile: AccountChoice;
	limit: UsageAccountLimit | null;
	onSelect: () => void;
	onLogin: () => void;
}) {
	const identity = useLoginIdentity(provider, profile.dir);
	const loggedOut = identity?.status === "unauthenticated";
	const label = identity?.email ?? profile.name;
	const usageDescription = [
		limit?.reset,
		limit?.pct != null ? `${Math.round(limit.pct)}%` : null,
		...(limit?.credits ?? []),
	]
		.filter((value): value is string => value != null)
		.join(" · ");
	const content = (
		<AccountMenuLabel
			label={label}
			limit={loggedOut ? null : limit}
			detail={loggedOut ? t("common.login") : undefined}
		/>
	);
	if (loggedOut)
		return (
			<DropdownMenuItem
				aria-label={t("common.loginWithName", { name: profile.name })}
				data-slot={`${provider}-subscription-usage`}
				onSelect={onLogin}
				className="pl-6"
			>
				{content}
			</DropdownMenuItem>
		);
	return (
		<DropdownMenuRadioItem
			value={profile.id ? `credential:${profile.id}` : "default"}
			aria-label={`${PROVIDERS[provider].label} ${label}`}
			aria-description={usageDescription || undefined}
			data-slot={`${provider}-subscription-usage`}
			onSelect={onSelect}
			className="pl-6 pr-2 data-[state=checked]:bg-glass-menu-hover [&>[data-slot=dropdown-menu-radio-item-indicator]]:left-1.5 [&>[data-slot=dropdown-menu-radio-item-indicator]]:right-auto [&>[data-slot=dropdown-menu-radio-item-indicator]]:top-1.5"
		>
			{content}
		</DropdownMenuRadioItem>
	);
}

export function UsageAccountMenu({
	provider,
	title,
	activeLabel,
	accountLimit,
}: {
	provider: Provider;
	title: string;
	activeLabel: string;
	accountLimit?: (profile: UsagePopoverAccount) => UsageAccountLimit | null;
}) {
	const accounts = useStore((state) => state.accounts);
	const activeId = useStore((state) => state.activeAccounts[provider]);
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	const setActiveAccount = useStore((state) => state.setActiveAccount);
	const profiles: AccountChoice[] = [
		{
			id: undefined,
			dir: undefined,
			name: t("common.default"),
			account: undefined,
		},
		...accounts
			.filter((account) => account.provider === provider)
			.map((account) => ({
				id: account.id,
				dir: account.dir,
				name: account.name,
				account,
			})),
	];
	if (profiles.length === 1) {
		return (
			<div className="flex h-7 min-w-0 items-center px-2 text-xs">
				<Titled title={activeLabel}>
					<span className="truncate">{activeLabel}</span>
				</Titled>
			</div>
		);
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					aria-label={t("usage.account.switch", { provider: title })}
					className="w-full min-w-0 justify-between gap-2 px-2 font-normal transition-colors"
				>
					<Titled title={activeLabel}>
						<span className="min-w-0 truncate">{activeLabel}</span>
					</Titled>
					<ChevronDown
						aria-hidden="true"
						className="size-3 text-muted-foreground"
					/>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				side="bottom"
				align="start"
				collisionPadding={8}
				className="w-(--radix-dropdown-menu-trigger-width) max-w-(--radix-dropdown-menu-content-available-width)"
			>
				<DropdownMenuRadioGroup
					value={activeId ? `credential:${activeId}` : "default"}
				>
					{profiles.map((profile) => (
						<AccountItem
							key={profile.id ?? "default"}
							provider={provider}
							profile={profile}
							limit={accountLimit?.(profile) ?? null}
							onSelect={() => setActiveAccount(provider, profile.id)}
							onLogin={() => {
								const api = getDockview(activeSpaceId);
								if (!api) return;
								openCommandTerminalOn(api, {
									title: t("common.loginWithName", { name: profile.name }),
									command: providerLoginCmd(provider, profile.account),
									closeOnSuccess: true,
								});
							}}
						/>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
