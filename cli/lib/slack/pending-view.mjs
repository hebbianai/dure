import { buildPendingQuestionAnswers, parsePendingPermissionPresentation, parsePendingQuestions } from "../contracts/agent-pending-presentation.mjs";

const plain = (text, limit) => ({ type: "plain_text", text: limit ? Array.from(text).slice(0, limit).join("") : text });
const sections = (text) => {
  const characters = Array.from(text);
  const blocks = [];
  for (let offset = 0; offset < characters.length; offset += 3000) blocks.push({ type: "section", text: plain(characters.slice(offset, offset + 3000).join("")) });
  return blocks;
};
const button = (action, label, key) => ({ type: "button", action_id: `dure.pending.${action}`, text: plain(label), value: key });

export function pendingPresentation(request) {
  if (request.kind === "question") return { kind: request.kind, questions: parsePendingQuestions(request.payload) };
  const permission = parsePendingPermissionPresentation(request.payload);
  return { kind: request.kind, permission, input: request.payload?.input };
}

export function canAnswerQuestions(presentation) {
  return presentation.questions?.length > 0 && !presentation.questions.some((question) => question.isSecret);
}

export function pendingMessage(entry, attempts) {
  const { presentation, key } = entry;
  const isPermission = presentation.kind === "permission";
  const { permission, questions } = presentation;
  let body;
  if (isPermission) {
    body = [permission.title ?? "Permission requested", permission.description, permission.blockedPath, permission.decisionReason,
      presentation.input === undefined ? undefined : JSON.stringify(presentation.input, null, 2)].filter(Boolean).join("\n\n");
  } else {
    body = questions?.map((question) => [question.question, ...question.options.map((option) =>
      `• ${option.label}${option.description ? ` — ${option.description}` : ""}`)].join("\n")).join("\n\n") ??
      "Dure could not display this question.";
  }
  const delivered = attempts.findLast((attempt) => attempt.state === "delivered" && (!entry.completion || attempt.intent.idempotencyKey === entry.completion.idempotencyKey));
  const latest = attempts.at(-1);
  const status = [];
  if (entry.completion) {
    const actor = delivered ? delivered.message.userName ?? delivered.message.userId : undefined;
    const answer = entry.completion.answer;
    if (answer.decision) {
      const decision = answer.decision === "allow" ? "allowed" : "declined";
      status.push(actor ? `${actor} ${decision} this request.` : `This request was ${decision}.`);
    }
    else status.push(`Answer delivered${actor ? ` from ${actor}` : ""}.`, ...answer.questions.map((question) => `${question.question}\n${question.answer ?? "Sensitive answer hidden."}`));
  } else if (delivered) {
    const actor = delivered.message.userName ?? delivered.message.userId;
    const answer = delivered.intent.answer;
    if (answer.decision) status.push(`${actor} ${answer.decision === "allow" ? "allowed" : "declined"} this request.`);
    else status.push(`Answer delivered from ${actor}.`, ...questions.map((question) => `${question.question}\n${answer.answers[question.id]}`));
  }
  if (latest?.state === "failed") {
    const actor = latest.message.userName ?? latest.message.userId;
    status.push(`The answer from ${actor} could not be delivered.${entry.resolved || delivered ? "" : " You can answer again."}`);
  } else if (!delivered && !entry.completion && entry.resolved) status.push("This request is no longer pending.");
  const text = [body, ...status, !entry.resolved && !delivered && !isPermission && questions?.some((question) => question.isSecret) ? "Sensitive answers cannot be collected here. You can decline this request." : undefined].filter(Boolean).join("\n\n");
  const blocks = sections(text);
  if (!entry.resolved && !delivered && !entry.completion) {
    const elements = [button("deny", isPermission ? "Deny" : "Decline", key)];
    if (isPermission) elements.push(button("allow", "Allow", key));
    else if (canAnswerQuestions(presentation)) elements.push(button("open", "Answer", key));
    blocks.push({ type: "actions", elements });
  }
  return { text, blocks };
}

export function pendingModal(entry) {
  const blocks = [];
  for (const [index, question] of entry.presentation.questions.entries()) {
    blocks.push(...sections(question.question));
    if (question.options.length) {
      blocks.push({ type: "input", block_id: `q${index}`, label: plain(question.header ?? "Choose an option", 2000), optional: question.allowOther,
        element: { type: question.multiSelect ? "multi_static_select" : "static_select", action_id: "choice",
          options: question.options.map((option, optionIndex) => ({ text: plain(option.label, 75), value: String(optionIndex),
            ...(option.description ? { description: plain(option.description, 75) } : {}) })) } });
    }
    if (question.allowOther) {
      blocks.push({ type: "input", block_id: `other${index}`, label: plain(question.options.length ? "Or write your answer" : "Your answer"),
        optional: question.options.length > 0, element: { type: "plain_text_input", action_id: "answer", multiline: true } });
    }
  }
  return { type: "modal", callback_id: "dure.pending.answer", private_metadata: entry.key,
    title: plain("Answer Dure"), submit: plain("Send answer"), close: plain("Cancel"), blocks };
}

export function pendingSubmission(entry, values) {
  const selections = {};
  const otherAnswers = {};
  const errors = {};
  for (const [index, question] of entry.presentation.questions.entries()) {
    const choice = values?.[`q${index}`]?.choice;
    const selected = question.multiSelect ? choice?.selected_options ?? [] : [choice?.selected_option].filter(Boolean);
    selections[index] = new Set(selected.filter((option) => /^\d+$/.test(option.value ?? "") && Number(option.value) < question.options.length).map((option) => Number(option.value)));
    const other = values?.[`other${index}`]?.answer?.value;
    if (question.allowOther && typeof other === "string") otherAnswers[index] = other;
    if (!otherAnswers[index]?.trim() && !selections[index].size) errors[question.options.length ? `q${index}` : `other${index}`] = "Choose an option or write an answer.";
  }
  const answers = buildPendingQuestionAnswers(entry.presentation.questions, selections, otherAnswers);
  return answers ? { answer: { answers } } : { errors };
}
