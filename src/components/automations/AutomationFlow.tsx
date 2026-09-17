import { ArrowRight, Bot, Clock3, FileText } from "lucide-react";
import { FormField } from "@/components/common/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Textarea } from "@/components/ui/textarea";
import { PROVIDERS } from "@/lib/agents/providerCatalog";
import type { ScheduleDraft } from "@/lib/automations/scheduleContract";
import { t } from "@/lib/i18n";
import type { ScheduleProject } from "@/lib/ipc/dureSchedule";

export type AutomationStep = "trigger" | "agent" | "result";

export function AutomationFlow({
	draft,
	step,
	setStep,
	setDraft,
	disabled,
	projects,
}: {
	draft: ScheduleDraft;
	step: AutomationStep;
	setStep: (step: AutomationStep) => void;
	setDraft: (draft: ScheduleDraft) => void;
	disabled: boolean;
	projects: ScheduleProject[];
}) {
	const steps = [
		{ id: "trigger", icon: Clock3, detail: draft.expression },
		{ id: "agent", icon: Bot, detail: draft.runTemplate.providerId },
		{ id: "result", icon: FileText, detail: t("automations.retainedReport") },
	] as const;
	return (
		<div className="grid min-h-0 min-w-0 gap-0 md:grid-cols-[minmax(0,1fr)_300px]">
			<div className="flex min-w-0 flex-col justify-center gap-8 bg-muted/20 px-5 py-10 md:py-16">
				<ol
					className="flex min-w-0 flex-wrap items-center justify-center gap-2"
					aria-label={t("automations.flow")}
				>
					{steps.map(({ id, icon: Icon, detail }, index) => (
						<li key={id} className="flex min-w-0 items-center gap-2">
							{index > 0 && (
								<ArrowRight
									className="size-4 text-muted-foreground"
									aria-hidden="true"
								/>
							)}
							<Button
								variant={step === id ? "outline" : "ghost"}
								className="h-auto w-[116px] flex-col items-start gap-3 rounded-xl border border-border bg-background px-3 py-4 text-left shadow-xs"
								aria-pressed={step === id}
								onClick={() => setStep(id)}
							>
								<Icon className="size-5 text-muted-foreground" />
								<span className="text-xs font-medium">
									{t(`automations.${id}`)}
								</span>
								<span className="block w-full truncate text-[10px] font-normal text-muted-foreground">
									{detail}
								</span>
							</Button>
						</li>
					))}
				</ol>
				<p className="mx-auto max-w-80 text-center text-xs leading-5 text-muted-foreground">
					{t("automations.flowScope")}
				</p>
			</div>
			<div className="min-w-0 border-t border-border p-5 md:border-t-0 md:border-l">
				<h3 className="mb-4 text-sm font-medium">{t(`automations.${step}`)}</h3>
				<fieldset disabled={disabled} className="grid min-w-0 gap-4">
					{step === "trigger" && (
						<>
							<FormField
								label={t("automations.expression")}
								description={t("automations.cronHelp")}
							>
								<Input
									value={draft.expression}
									onChange={(event) =>
										setDraft({ ...draft, expression: event.target.value })
									}
									className="font-mono text-xs"
								/>
							</FormField>
							<FormField label={t("automations.timezone")}>
								<Input
									value={draft.timezone}
									onChange={(event) =>
										setDraft({ ...draft, timezone: event.target.value })
									}
								/>
							</FormField>
							<FormField label={t("automations.activation")}>
								<SelectField
									value={draft.enabled ? "active" : "paused"}
									onValueChange={(nextValue) =>
										setDraft({
											...draft,
											enabled: nextValue === "active",
										})
									}
								>
									<SelectOption value="paused">
										{t("automations.paused")}
									</SelectOption>
									<SelectOption value="active">
										{t("automations.active")}
									</SelectOption>
								</SelectField>
							</FormField>
							<p className="text-xs leading-5 text-muted-foreground">
								{t("automations.runtimeHelp")}
							</p>
						</>
					)}
					{step === "agent" && (
						<>
							<FormField
								label={t("automations.project")}
								description={
									projects.length === 0
										? t("automations.noProjects")
										: undefined
								}
							>
								<SelectField
									value={draft.runTemplate.projectId}
									onValueChange={(nextValue) =>
										setDraft({
											...draft,
											runTemplate: {
												...draft.runTemplate,
												projectId: nextValue,
											},
										})
									}
								>
									<SelectOption value="">
										{t("automations.chooseProject")}
									</SelectOption>
									{draft.runTemplate.projectId &&
										!projects.some(
											(project) => project.id === draft.runTemplate.projectId,
										) && (
											<SelectOption value={draft.runTemplate.projectId}>
												{draft.runTemplate.projectId}
											</SelectOption>
										)}
									{projects.map((project) => (
										<SelectOption key={project.id} value={project.id}>
											{project.displayName}
										</SelectOption>
									))}
								</SelectField>
							</FormField>
							<FormField label={t("automations.provider")}>
								<SelectField
									value={draft.runTemplate.providerId}
									disabled={
										disabled ||
										draft.runTemplate.executionProfile?.kind ===
											"credential_reference"
									}
									onValueChange={(nextValue) =>
										setDraft({
											...draft,
											runTemplate: {
												...draft.runTemplate,
												providerId: nextValue,
												model: undefined,
												effort: undefined,
											},
										})
									}
								>
									{!Object.entries(PROVIDERS).some(
										([id, spec]) =>
											id === draft.runTemplate.providerId &&
											spec.workflowDelegate,
									) && (
										<SelectOption value={draft.runTemplate.providerId}>
											{draft.runTemplate.providerId}
										</SelectOption>
									)}
									{Object.entries(PROVIDERS)
										.filter(([, spec]) => spec.workflowDelegate)
										.map(([id, spec]) => (
											<SelectOption key={id} value={id}>
												{spec.label}
											</SelectOption>
										))}
								</SelectField>
							</FormField>
							{(["model", "effort"] as const).map((field) => (
								<FormField key={field} label={t(`automations.${field}`)}>
									<Input
										value={draft.runTemplate[field] ?? ""}
										placeholder={t("automations.providerDefault")}
										onChange={(event) =>
											setDraft({
												...draft,
												runTemplate: {
													...draft.runTemplate,
													[field]: event.target.value.trim() || undefined,
												},
											})
										}
									/>
								</FormField>
							))}
							<FormField label={t("automations.prompt")}>
								<Textarea
									className="min-h-32 text-xs"
									value={draft.runTemplate.prompt}
									onChange={(event) =>
										setDraft({
											...draft,
											runTemplate: {
												...draft.runTemplate,
												prompt: event.target.value,
											},
										})
									}
								/>
							</FormField>
							<FormField label={t("automations.permissions")}>
								<SelectField
									value={draft.runTemplate.permissionMode ?? "inherit"}
									onValueChange={(nextValue) =>
										setDraft({
											...draft,
											runTemplate: {
												...draft.runTemplate,
												permissionMode:
													nextValue === "inherit"
														? undefined
														: nextValue === "skip_permissions"
															? "skip_permissions"
															: "default",
											},
										})
									}
								>
									<SelectOption value="inherit">
										{t("automations.defaultPermissions")}
									</SelectOption>
									<SelectOption value="default">
										{t("automations.requireApprovals")}
									</SelectOption>
									<SelectOption value="skip_permissions">
										{t("automations.skipPermissions")}
									</SelectOption>
								</SelectField>
							</FormField>
							<p className="text-xs leading-5 text-muted-foreground">
								{t("automations.worktreeHelp")}
							</p>
						</>
					)}
					{step === "result" && (
						<p className="text-xs leading-6 text-muted-foreground">
							{t("automations.resultHelp")}
						</p>
					)}
				</fieldset>
			</div>
		</div>
	);
}
