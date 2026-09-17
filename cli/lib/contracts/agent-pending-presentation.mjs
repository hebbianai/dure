const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const nonEmptyText = (value) => typeof value === "string" && value.trim() ? value : undefined;

export function parsePendingPermissionPresentation(payload) {
  const request = record(payload);
  const presentation = record(request?.presentation);
  const title = nonEmptyText(presentation?.title) ?? nonEmptyText(presentation?.displayName) ?? nonEmptyText(request?.toolName);
  const description = nonEmptyText(presentation?.description);
  const blockedPath = nonEmptyText(presentation?.blockedPath);
  const decisionReason = nonEmptyText(presentation?.decisionReason);
  return {
    ...(title ? { title } : {}), ...(description ? { description } : {}),
    ...(blockedPath ? { blockedPath } : {}), ...(decisionReason ? { decisionReason } : {}),
  };
}

/** Project provider-normalized questions at each presentation boundary. The
 * common conversation timeline deliberately keeps the provider payload opaque. */
export function parsePendingQuestions(payload) {
  const request = record(payload);
  const input = record(request?.input);
  if (!Array.isArray(input?.questions) || input.questions.length === 0) return undefined;
  const questions = [];
  for (const value of input.questions) {
    const question = record(value);
    const questionText = nonEmptyText(question?.question);
    if (!questionText || !Array.isArray(question?.options)) return undefined;
    const id = nonEmptyText(question.id) ?? questionText;
    const options = [];
    for (const optionValue of question.options) {
      const option = record(optionValue);
      const label = nonEmptyText(option?.label);
      if (!label) return undefined;
      const description = nonEmptyText(option?.description);
      options.push({ label, ...(description ? { description } : {}) });
    }
    const header = nonEmptyText(question.header);
    questions.push({ id, question: questionText, ...(header ? { header } : {}), options,
      multiSelect: question.multiSelect === true,
      allowOther: question.allowOther === true || options.length === 0,
      isSecret: question.isSecret === true,
    });
  }
  return questions;
}

export function buildPendingQuestionAnswers(questions, selections, otherAnswers) {
  const answers = [];
  for (const [index, question] of questions.entries()) {
    const other = otherAnswers[index];
    if (other?.trim()) { answers.push([question.id, other]); continue; }
    const selected = selections[index];
    if (!selected?.size) return undefined;
    const labels = [...selected].sort((left, right) => left - right)
      .flatMap((optionIndex) => question.options[optionIndex] ? [question.options[optionIndex].label] : []).join(", ");
    if (!labels) return undefined;
    answers.push([question.id, labels]);
  }
  return Object.fromEntries(answers);
}

export function presentPendingAnswer(request, answer) {
  const value = record(answer);
  const decision = ["allow", "deny"].includes(value?.decision) ? value.decision : undefined;
  const questions = request.kind === "question" ? parsePendingQuestions(request.payload) ?? [] : [];
  const answers = record(value?.answers);
  return {
    ...(decision ? { decision } : {}),
    ...(request.kind === "permission" ? { permission: parsePendingPermissionPresentation(request.payload) } : {}),
    questions: questions.flatMap((question) => typeof answers?.[question.id] === "string" ? [{
      question: question.question,
      answer: question.isSecret ? null : answers[question.id],
    }] : []),
  };
}
