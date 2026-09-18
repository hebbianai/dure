import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { FormField } from "@/components/common/FormField";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Textarea } from "@/components/ui/textarea";
import { SlackChannelDefaults } from "@/components/plugins/SlackChannelDefaults";
import { PROVIDER_IDS, PROVIDERS } from "@/lib/agents/providerCatalog";
import { t } from "@/lib/i18n";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type { DureProjectOption } from "@/lib/ipc/dureProjects";
import type {
	SlackConnectionSnapshot,
	SlackConnectorClient,
} from "@/lib/ipc/slackConnector";
import {
	type SlackChannelRoute,
	type SlackConfiguration,
	type SlackConnection,
	slackConnectIntent,
	slackConnectionError,
} from "@/lib/plugins/slackConnection";

type Draft = Omit<SlackConfiguration, "channels"> & {
	channels: (SlackChannelRoute & { key: string })[];
};

export function SlackConnectionEditor({
	client,
	authority,
	connection,
	busy,
	launchDefaultsSupported = false,
	submit,
	onClose,
}: {
	client: SlackConnectorClient;
	authority: DureBackendRouteAuthorityV1;
	connection?: SlackConnection;
	busy: boolean;
	launchDefaultsSupported?: boolean;
	submit: (
		operation: () => Promise<SlackConnectionSnapshot>,
	) => Promise<boolean>;
	onClose: () => void;
}) {
	const [config, setConfig] = useState<Draft>(() => {
		const initial = connection?.config ?? {
			schemaVersion: 1,
			teamId: "",
			channels: [],
		};
		return {
			...initial,
			channels: initial.channels.map((route) => ({
				...route,
				key: crypto.randomUUID(),
			})),
		};
	});
	const [appToken, setAppToken] = useState("");
	const [botToken, setBotToken] = useState("");
	const [projects, setProjects] = useState<DureProjectOption[]>([]);
	const [projectError, setProjectError] = useState<string>();
	const [partial, setPartial] = useState(false);
	const [validationError, setValidationError] = useState<string>();
	useEffect(() => {
		let current = true;
		void client
			.projects(authority)
			.then((result) => {
				if (current) {
					setProjects(result.projects);
					setPartial(!result.complete);
				}
			})
			.catch((error) => {
				if (current) setProjectError(slackConnectionError(error));
			});
		return () => {
			current = false;
		};
	}, [client, authority]);
	function changeRoute(
		index: number,
		update: Partial<SlackConfiguration["channels"][number]>,
	) {
		setConfig((current) => ({
			...current,
			channels: current.channels.map((route, position) =>
				position === index ? { ...route, ...update } : route,
			),
		}));
	}
	async function connect() {
		setValidationError(undefined);
		let intent: ReturnType<typeof slackConnectIntent>;
		try {
			intent = slackConnectIntent(config, appToken, botToken);
		} catch (error) {
			setValidationError(
				error instanceof Error ? error.message : slackConnectionError(error),
			);
			return;
		}
		if (await submit(() => client.connect(intent, authority))) {
			setAppToken("");
			setBotToken("");
		}
	}
	return (
		<section
			className="space-y-4 border-t border-border px-4 py-4"
			aria-label={t("plugins.slack.connectionSettings")}
		>
			<div className="flex items-center justify-between gap-3">
				<h3 className="text-xs font-medium">
					{t("plugins.slack.connectionSettings")}
				</h3>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					aria-label={t("common.close")}
					onClick={onClose}
				>
					<X />
				</Button>
			</div>
			<fieldset disabled={busy} className="space-y-4">
				<FormField
					label={t("plugins.slack.workspace")}
					description={t("plugins.slack.workspaceHint")}
				>
					<Input
						value={config.teamId}
						disabled={connection !== undefined}
						placeholder="https://app.slack.com/client/T…"
						onChange={(event) =>
							setConfig({ ...config, teamId: event.target.value })
						}
					/>
				</FormField>
				<details open={!connection?.credentialsConfigured}>
					<summary className="cursor-pointer text-xs font-medium">
						{t(
							connection?.credentialsConfigured
								? "plugins.slack.replaceTokens"
								: "plugins.slack.tokens",
						)}
					</summary>
					<div className="mt-3 grid gap-3 sm:grid-cols-2">
						<FormField label={t("plugins.slack.appToken")}>
							<Input
								type="password"
								autoComplete="off"
								spellCheck={false}
								value={appToken}
								onChange={(event) => setAppToken(event.target.value)}
							/>
						</FormField>
						<FormField label={t("plugins.slack.botToken")}>
							<Input
								type="password"
								autoComplete="off"
								spellCheck={false}
								value={botToken}
								onChange={(event) => setBotToken(event.target.value)}
							/>
						</FormField>
					</div>
					<p className="mt-2 text-xs text-muted-foreground">
						{t("plugins.slack.tokensHint")}
					</p>
				</details>
				<div className="space-y-3">
					<div>
						<h4 className="text-xs font-medium">
							{t("plugins.slack.channels")}
						</h4>
						<p className="mt-1 text-xs leading-5 text-muted-foreground">
							{t("plugins.slack.channelsHint")}
						</p>
					</div>
					{projectError && (
						<Alert icon={false} className="text-xs">
							{projectError}
						</Alert>
					)}
					{partial && (
						<p className="text-xs text-muted-foreground">
							{t("plugins.slack.projectsPartial")}
						</p>
					)}
					{config.channels.map((route, index) => (
						<div
							key={route.key}
							className="space-y-3 border-t border-border pt-3"
						>
							<div className="flex items-end gap-2">
								<FormField
									className="flex-1"
									label={t("plugins.slack.channel")}
								>
									<Input
										value={route.channelId}
										placeholder={t("plugins.slack.channelPlaceholder")}
										onChange={(event) =>
											changeRoute(index, { channelId: event.target.value })
										}
									/>
								</FormField>
								<Button
									type="button"
									size="icon-sm"
									variant="ghost"
									aria-label={t("plugins.slack.removeChannel")}
									onClick={() =>
										setConfig({
											...config,
											channels: config.channels.filter(
												(_, position) => position !== index,
											),
										})
									}
								>
									<X />
								</Button>
							</div>
							<div className="grid gap-3 sm:grid-cols-2">
								<FormField label={t("plugins.slack.project")}>
									{projects.length > 0 && !route.backend ? (
										<SelectField
											value={route.projectId}
											onValueChange={(projectId) =>
												changeRoute(index, { projectId })
											}
										>
											<SelectOption value="">
												{t("plugins.slack.chooseProject")}
											</SelectOption>
											{route.projectId &&
												!projects.some(
													(project) => project.id === route.projectId,
												) && (
													<SelectOption value={route.projectId}>
														{route.projectId}
													</SelectOption>
												)}
											{projects.map((project) => (
												<SelectOption key={project.id} value={project.id}>
													{project.displayName}
												</SelectOption>
											))}
										</SelectField>
									) : (
										<Input
											value={route.projectId}
											placeholder={t("plugins.slack.projectPlaceholder")}
											onChange={(event) =>
												changeRoute(index, { projectId: event.target.value })
											}
										/>
									)}
								</FormField>
								<FormField label={t("plugins.slack.provider")}>
									<SelectField
										value={route.providerId}
										onValueChange={(providerId) =>
											changeRoute(index, {
												providerId,
												model: undefined,
												effort: undefined,
												accountId: undefined,
											})
										}
									>
										{!PROVIDER_IDS.some((id) => id === route.providerId) && (
											<SelectOption value={route.providerId}>
												{route.providerId}
											</SelectOption>
										)}
										{PROVIDER_IDS.map((id) => (
											<SelectOption key={id} value={id}>
												{PROVIDERS[id].label}
											</SelectOption>
										))}
									</SelectField>
								</FormField>
							</div>
							<FormField label={t("plugins.slack.objective")}>
								<Textarea
									rows={2}
									value={route.objective ?? ""}
									onChange={(event) =>
										changeRoute(index, { objective: event.target.value })
									}
								/>
							</FormField>
							{launchDefaultsSupported ? (
								<SlackChannelDefaults
									route={route}
									authority={authority}
									client={client}
									onChange={(update) => changeRoute(index, update)}
								/>
							) : (
								<p className="text-xs text-muted-foreground">
									{t("plugins.slack.defaultsUnavailable")}
								</p>
							)}
							<details>
								<summary className="cursor-pointer text-xs text-muted-foreground">
									{t("plugins.slack.executionOptions")}
								</summary>
								<div className="mt-3 grid gap-3 sm:grid-cols-2">
									<FormField
										label={t("plugins.slack.executionServer")}
										description={t("plugins.slack.executionServerHint")}
									>
										<Input
											value={route.backend ?? ""}
											placeholder={authority.profileId}
											onChange={(event) =>
												changeRoute(index, {
													backend: event.target.value,
													accountId: undefined,
												})
											}
										/>
									</FormField>
									<FormField label={t("plugins.slack.space")}>
										<Input
											value={route.space ?? ""}
											onChange={(event) =>
												changeRoute(index, { space: event.target.value })
											}
										/>
									</FormField>
								</div>
							</details>
						</div>
					))}
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() =>
							setConfig({
								...config,
								channels: [
									...config.channels,
									{
										key: crypto.randomUUID(),
										channelId: "",
										projectId: projects[0]?.id ?? "",
										providerId: "claude",
									},
								],
							})
						}
					>
						<Plus />
						{t("plugins.slack.addChannel")}
					</Button>
				</div>
				<Button type="button" size="sm" onClick={() => void connect()}>
					{t(busy ? "plugins.slack.saving" : "plugins.slack.saveConnect")}
				</Button>
				{validationError && <Alert>{validationError}</Alert>}
			</fieldset>
		</section>
	);
}
