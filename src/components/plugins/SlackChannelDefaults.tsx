import { useEffect, useId, useState } from "react";
import { FormField } from "@/components/common/FormField";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/lib/i18n";
import { PROVIDER_IDS } from "@/lib/agents/providerCatalog";
import {
	catalogEffortOptions,
	type ObservedProviderModelV1,
} from "@/lib/agents/providerModels";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type { SlackConnectorClient } from "@/lib/ipc/slackConnector";
import type {
	SlackChannelRoute,
	SlackPermissionOverride,
} from "@/lib/plugins/slackConnection";

export function SlackChannelDefaults({
	route,
	authority,
	client,
	onChange,
}: {
	route: SlackChannelRoute;
	authority: DureBackendRouteAuthorityV1;
	client: SlackConnectorClient;
	onChange(update: Partial<SlackChannelRoute>): void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<details onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary className="cursor-pointer text-xs font-medium">
				{t("plugins.slack.launchDefaults")}
			</summary>
			{open && (
				<Defaults
					key={JSON.stringify([route.providerId, route.backend, authority])}
					{...{ route, authority, client, onChange }}
				/>
			)}
		</details>
	);
}

function Defaults({
	route,
	authority,
	client,
	onChange,
}: Parameters<typeof SlackChannelDefaults>[0]) {
	const id = useId();
	const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
	const [models, setModels] = useState<readonly ObservedProviderModelV1[]>([]);
	const [accountError, setAccountError] = useState(false);
	const [modelError, setModelError] = useState(false);
	useEffect(() => {
		if (route.backend) return;
		let current = true;
		void client.accounts(route.providerId, authority).then(
			(snapshot) => {
				if (current)
					setAccounts(
						snapshot.profiles.map((profile) => ({
							id: profile.referenceId,
							name:
								snapshot.policy?.accounts.find(
									(account) =>
										account.profile.referenceId === profile.referenceId,
								)?.name ?? profile.referenceId,
						})),
					);
			},
			() => {
				if (current) setAccountError(true);
			},
		);
		void client.models(route.providerId, authority).then(
			(next) => {
				if (current) setModels(next);
			},
			() => {
				if (current) setModelError(true);
			},
		);
		return () => {
			current = false;
		};
	}, [client, authority, route.providerId, route.backend]);
	const provider = PROVIDER_IDS.find(
		(provider) => provider === route.providerId,
	);
	const efforts = provider
		? catalogEffortOptions(provider, models, route.model || null)
		: [];
	return (
		<div className="mt-3 space-y-3">
			<p className="text-xs text-muted-foreground">
				{t("plugins.slack.defaultsHint")}
			</p>
			<div className="grid gap-3 sm:grid-cols-2">
				<FormField label={t("agents.chat.modelLabel")} htmlFor={`${id}-model`}>
					<Input
						id={`${id}-model`}
						list={`${id}-models`}
						value={route.model ?? ""}
						placeholder={t("plugins.slack.inheritDefault")}
						onChange={(event) =>
							onChange({ model: event.target.value, effort: undefined })
						}
					/>
					<datalist id={`${id}-models`}>
						{models.map((model) => (
							<option key={model.value} value={model.value}>
								{model.displayName}
							</option>
						))}
					</datalist>
				</FormField>
				<FormField
					label={t("agents.chat.effortLabel")}
					htmlFor={`${id}-effort`}
				>
					<Input
						id={`${id}-effort`}
						list={`${id}-efforts`}
						value={route.effort ?? ""}
						placeholder={t("plugins.slack.inheritDefault")}
						onChange={(event) => onChange({ effort: event.target.value })}
					/>
					<datalist id={`${id}-efforts`}>
						{efforts.map((effort) => (
							<option key={effort.value} value={effort.value}>
								{effort.label}
							</option>
						))}
					</datalist>
				</FormField>
			</div>
			{modelError && (
				<p className="text-xs text-muted-foreground">
					{t("plugins.slack.modelHint")}
				</p>
			)}
			<FormField
				label={t("plugins.slack.defaultAccount")}
				description={t("plugins.slack.accountHint")}
			>
				{route.backend ? (
					<Input
						value={route.accountId ?? ""}
						placeholder={t("plugins.slack.inheritDefault")}
						onChange={(event) => onChange({ accountId: event.target.value })}
					/>
				) : (
					<SelectField
						value={route.accountId ?? ""}
						onValueChange={(accountId) =>
							onChange({ accountId: accountId || undefined })
						}
					>
						<SelectOption value="">
							{t("agents.quickDispatch.defaultAccount")}
						</SelectOption>
						{route.accountId &&
							!accounts.some((account) => account.id === route.accountId) && (
								<SelectOption value={route.accountId}>
									{route.accountId}
								</SelectOption>
							)}
						{accounts.map((account) => (
							<SelectOption key={account.id} value={account.id}>
								{account.name}
							</SelectOption>
						))}
					</SelectField>
				)}
			</FormField>
			{accountError && (
				<p className="text-xs text-muted-foreground">
					{t("plugins.slack.accountsUnavailable")}
				</p>
			)}
			<FormField label={t("plugins.slack.approvals")}>
				<SelectField
					value={route.permissionOverride ?? ""}
					onValueChange={(value) =>
						onChange({
							permissionOverride: value
								? (value as SlackPermissionOverride)
								: undefined,
						})
					}
				>
					<SelectOption value="">
						{t("plugins.slack.inheritDefault")}
					</SelectOption>
					<SelectOption value="require_approvals">
						{t("plugins.slack.requireApprovals")}
					</SelectOption>
					<SelectOption value="auto_edit">
						{t("plugins.slack.autoEdit")}
					</SelectOption>
					<SelectOption value="bypass_approvals">
						{t("plugins.slack.bypassApprovals")}
					</SelectOption>
				</SelectField>
			</FormField>
			{route.permissionOverride === "bypass_approvals" && (
				<p className="text-xs text-muted-foreground">
					{t("agents.permission.bypassHint")}
				</p>
			)}
			<FormField label={t("plugins.slack.instructions")}>
				<Textarea
					rows={3}
					value={route.instructions ?? ""}
					onChange={(event) => onChange({ instructions: event.target.value })}
				/>
			</FormField>
		</div>
	);
}
