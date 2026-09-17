import { useId, useMemo, useState } from "react";
import { CodeBlock } from "@/components/common/CodeBlock";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AgentPendingRequestV1 } from "@/lib/agents/chat/agentConversationContract";
import {
	buildPendingQuestionAnswers,
	parsePendingPermissionPresentation,
	parsePendingQuestions,
} from "@/lib/agents/chat/agentPendingPresentation";
import { opaqueJsonText } from "@/lib/agents/chat/chatFormat";
import { Disclosure } from "@/components/ui/disclosure";
import { t } from "@/lib/i18n";

function PendingQuestionForm({
	questions,
	requestId,
	busy,
	onAnswer,
}: {
	questions: ReturnType<typeof parsePendingQuestions>;
	requestId: string;
	busy: boolean;
	onAnswer(value: unknown): void;
}) {
	const formId = useId();
	const [selections, setSelections] = useState<Record<number, Set<number>>>({});
	const [otherAnswers, setOtherAnswers] = useState<Record<number, string>>({});
	if (!questions) {
		return (
			<div className="mt-3 flex justify-end">
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={() => onAnswer({ decision: "deny" })}
				>
					{t("agents.chat.declineQuestion")}
				</Button>
			</div>
		);
	}
	if (questions.some((question) => question.isSecret)) {
		return (
			<div className="mt-3 space-y-3">
				<p className="text-[11px] leading-4 text-muted-foreground">
					{t("agents.chat.sensitiveAnswerUnsupported")}
				</p>
				<div className="flex justify-end">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => onAnswer({ decision: "deny" })}
					>
						{t("agents.chat.declineQuestion")}
					</Button>
				</div>
			</div>
		);
	}

	const answers = buildPendingQuestionAnswers(
		questions,
		selections,
		otherAnswers,
	);
	const toggleOption = (
		questionIndex: number,
		optionIndex: number,
		multiSelect: boolean,
	) => {
		setSelections((current) => {
			const next = new Set(current[questionIndex]);
			if (multiSelect && next.has(optionIndex)) next.delete(optionIndex);
			else {
				if (!multiSelect) next.clear();
				next.add(optionIndex);
			}
			return { ...current, [questionIndex]: next };
		});
		setOtherAnswers((current) => {
			if (!current[questionIndex]) return current;
			const next = { ...current };
			delete next[questionIndex];
			return next;
		});
	};

	return (
		<form
			className="mt-3 space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (!answers || busy) return;
				onAnswer({ answers });
			}}
		>
			{questions.map((question, questionIndex) => {
				const selected = selections[questionIndex] ?? new Set<number>();
				return (
					<fieldset key={question.id} className="space-y-2">
						<legend className="text-[13px] leading-5 font-medium text-foreground">
							{question.header && (
								<span className="mb-0.5 block text-[10px] tracking-wide text-muted-foreground uppercase">
									{question.header}
								</span>
							)}
							<span className="block">{question.question}</span>
						</legend>
						{question.options.length > 0 && (
							<div className="space-y-1.5">
								{question.options.map((option, optionIndex) => {
									const isSelected = selected.has(optionIndex);
									const labelId = `${formId}-q${questionIndex}-o${optionIndex}-label`;
									const descriptionId = `${formId}-q${questionIndex}-o${optionIndex}-description`;
									return (
										<label
											key={`${optionIndex}:${option.label}`}
											className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
												isSelected
													? "border-foreground/30 bg-muted/70"
													: "border-border/70 bg-background hover:bg-muted/35"
											} ${busy ? "cursor-not-allowed opacity-50" : ""}`}
										>
											<input
												type={question.multiSelect ? "checkbox" : "radio"}
												name={`${requestId}:question:${questionIndex}`}
												checked={isSelected}
												disabled={busy}
												aria-labelledby={labelId}
												aria-describedby={
													option.description ? descriptionId : undefined
												}
												className="mt-0.5 size-3.5 shrink-0 accent-foreground"
												onChange={() =>
													toggleOption(
														questionIndex,
														optionIndex,
														question.multiSelect,
													)
												}
											/>
											<span className="min-w-0">
												<span
													id={labelId}
													className="block text-xs font-medium text-foreground"
												>
													{option.label}
												</span>
												{option.description && (
													<span
														id={descriptionId}
														className="mt-0.5 block text-[11px] leading-4 text-muted-foreground"
													>
														{option.description}
													</span>
												)}
											</span>
										</label>
									);
								})}
							</div>
						)}
						{question.allowOther && (
							<label className="block space-y-1.5">
								<span className="text-[11px] text-muted-foreground">
									{question.options.length > 0
										? t("agents.chat.otherAnswer")
										: t("agents.chat.answerPlaceholder")}
								</span>
								<Input
									value={otherAnswers[questionIndex] ?? ""}
									placeholder={t("agents.chat.answerPlaceholder")}
									disabled={busy}
									onChange={(event) => {
										const value = event.target.value;
										setOtherAnswers((current) => ({
											...current,
											[questionIndex]: value,
										}));
										if (value) {
											setSelections((current) => ({
												...current,
												[questionIndex]: new Set(),
											}));
										}
									}}
								/>
							</label>
						)}
					</fieldset>
				);
			})}
			<div className="flex flex-wrap justify-end gap-2">
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={() => onAnswer({ decision: "deny" })}
				>
					{t("agents.chat.declineQuestion")}
				</Button>
				<Button type="submit" size="sm" disabled={busy || !answers}>
					{t("agents.chat.submitAnswer")}
				</Button>
			</div>
		</form>
	);
}

export function AgentPendingRequestCard({
	pending,
	busy,
	onAnswer,
}: {
	pending: AgentPendingRequestV1;
	busy: boolean;
	onAnswer(answer: unknown): void;
}) {
	const headingId = useId();
	const [detailsExpanded, setDetailsExpanded] = useState(false);
	const permission = useMemo(
		() => parsePendingPermissionPresentation(pending.request.payload),
		[pending.request.payload],
	);
	const questions = useMemo(
		() =>
			pending.request.kind === "question"
				? parsePendingQuestions(pending.request.payload)
				: undefined,
		[pending.request.kind, pending.request.payload],
	);
	return (
		<section
			aria-labelledby={
				pending.request.kind === "permission" || questions
					? headingId
					: undefined
			}
			className="min-w-0 [overflow-wrap:anywhere] rounded-xl border border-border/70 bg-background px-3 py-3 text-xs"
		>
			<div className="flex gap-2.5">
				<span
					aria-hidden="true"
					className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
				/>
				<div className="min-w-0">
					<h3 id={headingId} className="font-medium text-foreground">
						{pending.request.kind === "permission"
							? (permission.title ?? t("agents.chat.permissionRequired"))
							: t("agents.chat.questionRequired")}
						{pending.request.kind === "question" && questions?.[0] && (
							<span className="sr-only">: {questions[0].question}</span>
						)}
					</h3>
					{pending.request.kind === "permission" && permission.description && (
						<p className="mt-1 leading-4 text-muted-foreground">
							{permission.description}
						</p>
					)}
					{pending.request.kind === "permission" && permission.blockedPath && (
						<code className="mt-1.5 block truncate font-mono text-[11px] text-muted-foreground">
							{permission.blockedPath}
						</code>
					)}
					{pending.request.kind === "permission" &&
						permission.decisionReason && (
							<p className="mt-1 text-[11px] leading-4 text-muted-foreground">
								{permission.decisionReason}
							</p>
						)}
				</div>
			</div>

			{pending.request.kind === "question" && (
				<PendingQuestionForm
					questions={questions}
					requestId={pending.request.requestId}
					busy={busy}
					onAnswer={onAnswer}
				/>
			)}

			<Disclosure
				className="mt-3"
				label={t("agents.chat.requestDetails")}
				bodyClassName="mt-2"
				onToggle={(event) => setDetailsExpanded(event.currentTarget.open)}
			>
				{detailsExpanded && (
					<CodeBlock maxHeightClass="max-h-56">
						{opaqueJsonText(pending.request.payload)}
					</CodeBlock>
				)}
			</Disclosure>

			{pending.request.kind === "permission" && (
				<div className="mt-3 flex flex-wrap justify-end gap-2">
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => onAnswer({ decision: "deny" })}
					>
						{t("agents.chat.deny")}
					</Button>
					<Button
						size="sm"
						disabled={busy}
						onClick={() => onAnswer({ decision: "allow" })}
					>
						{t("agents.chat.allow")}
					</Button>
				</div>
			)}
		</section>
	);
}
