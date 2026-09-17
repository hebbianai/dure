import fs from "node:fs";
import path from "node:path";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";
import { createReceiptLossFixture } from "./lib/spawn-prompt-receipt-loss-fixture.mjs";
import { resolveQaLogPath } from "./lib/qa-log-receipt.mjs";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const stateRoot = required("DURE_QA_STATE_ROOT");
const projectPath = required("DURE_QA_PROJECT");
const prompt = required("DURE_QA_PROMPT");
const descriptorPath = required("DURE_QA_SERVER_DESCRIPTOR");
const { projectReadyEvent, providerInputs } = createReceiptLossFixture({
  captureRoot: path.join(stateRoot, "provider-capture"),
});
const qaLogPath = resolveQaLogPath();
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function descriptor() {
  return JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
}

async function waitFor(description, observe, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await observe();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for ${description}; last=${JSON.stringify(last)}`,
  );
}

async function getReceipt(receiptId) {
  const server = descriptor();
  const response = await fetch(
    `http://127.0.0.1:${server.port}/spawn/${receiptId}`,
    {
      headers: { Authorization: `Bearer ${server.token}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  const body = await response.json();
  if (!response.ok || body?.ok !== true) {
    throw new Error(`spawn receipt failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body.receipt;
}

function qaEntries() {
  if (!fs.existsSync(qaLogPath)) return [];
  return fs
    .readFileSync(qaLogPath, "utf8")
    .split("\n")
    .flatMap((line) => {
      const boundary = line.indexOf("] ");
      if (boundary < 0) return [];
      try {
        return [JSON.parse(line.slice(boundary + 2))];
      } catch {
        return [];
      }
    });
}

async function waitForFrontend() {
  await waitFor("frontend control listener", async () => {
    try {
      await requestAppControl({
        descriptor: descriptor(),
        path: "/diagnostics",
        timeoutMs: 2_000,
      });
      return true;
    } catch {
      return false;
    }
  });
}

await waitForFrontend();
const project = await waitFor("durable QA project", () =>
  qaEntries()
    .filter((entry) => Array.isArray(entry) && entry[0] === projectReadyEvent)
    .map((entry) => entry[1])
    .find((entry) => entry?.ready === true && entry.path === projectPath),
);

const created = await requestAppControl({
  descriptor: descriptor(),
  path: "/spawn/v2",
  body: {
    idempotencyKey: `qa-prompt-receipt-loss-${process.pid}`,
    project: project.projectId,
    name: `prompt-receipt-loss-${process.pid}`,
    provider: "claude",
    prompt,
    runtime: "hmux",
    useWorktree: false,
  },
  timeoutMs: 10_000,
});
const receiptId = created.receiptId;
if (typeof receiptId !== "string" || !receiptId) {
  throw new Error(`spawn did not return a receipt id: ${JSON.stringify(created)}`);
}

const interrupted = await waitFor("post-Host journal interruption", async () => {
  const receipt = await getReceipt(receiptId);
  const runtime = receipt.steps.find((step) => step.step === "runtime_session");
  const promptStep = receipt.steps.find((step) => step.step === "prompt_delivery");
  const sessionId = runtime?.detail?.sessionId;
  const faultObserved = qaEntries().some(
    (entry) =>
      Array.isArray(entry) &&
      entry[0] === "console.error" &&
      entry.some(
        (value) =>
          typeof value === "string" &&
          value.includes("qa_prompt_success_append_failed"),
      ),
  );
  if (receipt.state !== "running") {
    return { expected: false, receipt, faultObserved };
  }
  if (
    faultObserved &&
    promptStep?.status === "running" &&
    promptStep.detail?.deliveryContract === "host_atomic_v1" &&
    typeof sessionId === "string"
  ) {
    const inputs = providerInputs(sessionId);
    if (inputs.length === 1) {
      return { expected: true, receipt, sessionId, inputs };
    }
    if (inputs.length > 1) {
      return { expected: false, receipt, sessionId, inputs, faultObserved };
    }
  }
  return false;
});
if (!interrupted.expected) {
  throw new Error(
    `receipt-loss fault was not observed before saga completion: ${JSON.stringify(interrupted)}`,
  );
}
if (interrupted.inputs[0] !== prompt) {
  throw new Error(`provider received unexpected input: ${JSON.stringify(interrupted.inputs)}`);
}

await requestAppControl({
  descriptor: descriptor(),
  path: "/webview/reload",
  timeoutMs: 10_000,
});

const recovered = await waitFor("unverified boot recovery", async () => {
  const receipt = await getReceipt(receiptId);
  return receipt.state === "manual_intervention_required" ? receipt : false;
});
const recoveredPrompt = recovered.steps.find(
  (step) => step.step === "prompt_delivery",
);
if (
  recoveredPrompt?.status !== "failed" ||
  recoveredPrompt.error?.code !== "prompt_delivery_unverified" ||
  recoveredPrompt.error?.deliveryState !== "unknown" ||
  recoveredPrompt.delivery?.state !== "unverified" ||
  recoveredPrompt.delivery?.receipt !== undefined
) {
  throw new Error(`unexpected recovered prompt state: ${JSON.stringify(recoveredPrompt)}`);
}

const recoveredEndedAt = recoveredPrompt.endedAt;
if (typeof recoveredEndedAt !== "number") {
  throw new Error(
    `recovered prompt has no completion stamp: ${JSON.stringify(recoveredPrompt)}`,
  );
}
while (Date.now() <= recovered.updatedAt) await sleep(1);
await waitForFrontend();
await requestAppControl({
  descriptor: descriptor(),
  path: "/spawn/v2",
  body: { receiptId, prompt },
  timeoutMs: 10_000,
});
const refusedRetry = await waitFor("completed explicit retry refusal", async () => {
  const receipt = await getReceipt(receiptId);
  const promptStep = receipt.steps.find(
    (step) => step.step === "prompt_delivery",
  );
  if (
    receipt.state === "manual_intervention_required" &&
    promptStep?.status === "failed" &&
    promptStep.endedAt > recoveredEndedAt
  ) {
    return { receipt, promptStep };
  }
  return false;
});
if (
  refusedRetry.promptStep.error?.code !== "prompt_delivery_unverified" ||
  refusedRetry.promptStep.error?.deliveryState !== "unknown"
) {
  throw new Error(
    `retry did not preserve unknown delivery: ${JSON.stringify(refusedRetry.promptStep)}`,
  );
}
const finalInputs = providerInputs(interrupted.sessionId);
if (finalInputs.length !== 1 || finalInputs[0] !== prompt) {
  throw new Error(`prompt was replayed after receipt loss: ${JSON.stringify(finalInputs)}`);
}

console.log(
  `spawn prompt receipt-loss smoke: ${receiptId} recovered unverified with one provider input`,
);
