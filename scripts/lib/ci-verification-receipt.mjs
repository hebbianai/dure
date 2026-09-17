import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyChangedPaths,
  PUSH_GATE_SCOPES,
} from "./push-gate-scope.mjs";
import { requiresHmuxArtifact } from "./hmux-artifact-impact.mjs";
import { requiresHmuxBackgroundSmoke } from "./hmux-background-smoke-scope.mjs";
import { parseCompletedVerificationDiagnostics } from "./verification-diagnostics.mjs";

export { requiresHmuxArtifact } from "./hmux-artifact-impact.mjs";
export { requiresHmuxBackgroundSmoke } from "./hmux-background-smoke-scope.mjs";

export const CI_PRODUCT_VERIFICATION_ARTIFACT =
  "ci-product-verification-receipt-v3";
export const PRE_CAPABILITY_CI_VERIFICATION_ARTIFACT =
  "ci-verification-receipt-v2";
export const CI_HMUX_BACKGROUND_SMOKE_ARTIFACT =
  "ci-hmux-background-smoke-receipt-v1";
export const CI_VERIFICATION_RECEIPT_FILE = "receipt.json";
export const CI_VERIFICATION_SCHEMA = "dure-ci-verification/v3";
export const CI_VERIFICATION_PLAN_SCHEMA = "dure-ci-verification-plan/v2";
export const PRE_CAPABILITY_CI_VERIFICATION_SCHEMA =
  "hebbian-ci-verification/v2";
export const LEGACY_CI_VERIFICATION_SCHEMA = "hebbian-ci-verification/v1";
export const CI_PRODUCT_GATE_CAPABILITY = "product-gate";
export const CI_HMUX_BACKGROUND_SMOKE_CAPABILITY =
  "hmux-background-smoke";
export const CI_BEHAVIOR_RECEIPT_SCHEMA = "dure-ci-behavior/v1";
export const ALL_VERIFICATION_SCOPES = PUSH_GATE_SCOPES;

const FULL_SHA = /^[0-9a-f]{40}$/i;
const RUN_ID = /^[1-9][0-9]*$/;
const PRODUCT_CAPABILITIES = Object.freeze([CI_PRODUCT_GATE_CAPABILITY]);
const BEHAVIOR_CAPABILITIES = Object.freeze([
  CI_HMUX_BACKGROUND_SMOKE_CAPABILITY,
]);
const RECEIPT_LOAD_BATCH_SIZE = 4;

// v1 `full` predated the real mobile workspace gates. It
// can still prove consumers that the old gate actually exercised, but it must
// never become a v2 all-scopes watermark or satisfy one of those new scopes.
const LEGACY_FULL_SCOPES = Object.freeze(
  PUSH_GATE_SCOPES.filter(
    (scope) =>
      scope !== "mobile-rust" &&
      scope !== "mobile-web",
  ),
);

export function normalizeCommitSha(value, label = "commit SHA") {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new Error(`${label} must be a full 40-character commit SHA`);
  }
  return value.toLowerCase();
}

export function productReceiptRecords(repository, request) {
  return receiptArtifactRecords(
    repository,
    request,
    CI_PRODUCT_VERIFICATION_ARTIFACT,
  );
}

/** behavior(smoke) 영수증 아티팩트 목록 — 워크플로 무관하게 이름으로 조회하므로
 *  canary 워크플로가 발행한 영수증도 자연히 재사용 후보 풀에 합류한다. */
export function behaviorReceiptRecords(repository, request) {
  return receiptArtifactRecords(
    repository,
    request,
    CI_HMUX_BACKGROUND_SMOKE_ARTIFACT,
  );
}

function receiptArtifactRecords(repository, request, artifactName) {
  if (typeof request !== "function") {
    throw new Error("GitHub artifact request function is required");
  }
  const output = request([
    "api",
    `repos/${repository}/actions/artifacts?name=${artifactName}&per_page=100`,
  ]);
  const response = JSON.parse(output);
  if (!Array.isArray(response?.artifacts)) {
    throw new Error("GitHub artifact response did not contain an array");
  }
  const records = [];
  const runIds = new Set();
  for (const artifact of response.artifacts) {
    try {
      const artifactId = String(artifact.id ?? "");
      const databaseId = String(artifact.workflow_run?.id ?? "");
      if (
        artifact.expired ||
        !/^[1-9][0-9]*$/.test(artifactId) ||
        !/^[1-9][0-9]*$/.test(databaseId) ||
        runIds.has(databaseId)
      ) {
        continue;
      }
      const headSha = normalizeCommitSha(
        artifact.workflow_run?.head_sha,
        "artifact run head",
      );
      runIds.add(databaseId);
      records.push({
        artifactId,
        conclusion: null,
        databaseId,
        headSha,
        status: "artifact-published",
      });
    } catch {
      // Malformed artifact metadata cannot identify reusable proof.
    }
  }
  return records;
}

function normalizeRunId(value) {
  const normalized = String(value ?? "");
  if (!RUN_ID.test(normalized)) {
    throw new Error("CI verification runId must be a positive integer");
  }
  return normalized;
}

function normalizeScopes(scopes, label = "CI verification scopes") {
  if (!Array.isArray(scopes)) {
    throw new Error(`${label} must be an array`);
  }

  const selected = new Set();
  for (const scope of scopes) {
    if (typeof scope !== "string" || !PUSH_GATE_SCOPES.includes(scope)) {
      throw new Error(`${label} contains an unsupported scope`);
    }
    selected.add(scope);
  }
  return PUSH_GATE_SCOPES.filter((scope) => selected.has(scope));
}

function isCanonicalScopeSet(scopes, canonical) {
  return (
    scopes.length === canonical.length &&
    scopes.every((scope, index) => scope === canonical[index])
  );
}

function normalizeCapabilities(capabilities, allowed, label) {
  if (!Array.isArray(capabilities)) {
    throw new Error(`${label} must be an array`);
  }
  const selected = new Set();
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !allowed.includes(capability)) {
      throw new Error(`${label} contains an unsupported capability`);
    }
    selected.add(capability);
  }
  return allowed.filter((capability) => selected.has(capability));
}

function isCanonicalSet(values, canonical) {
  return (
    Array.isArray(values) &&
    values.length === canonical.length &&
    values.every((value, index) => value === canonical[index])
  );
}

export function classifyVerificationScopes(paths) {
  return classifyChangedPaths(paths);
}

export function parseVerificationPlanHandoff(
  {
    requiresHmuxArtifact,
    requiresHmuxSmoke,
    schema,
    scopes,
    verifiedBase,
    verifiedHead,
  },
  expectedHead,
) {
  if (schema !== CI_VERIFICATION_PLAN_SCHEMA) {
    throw new Error("CI verification plan schema is unsupported");
  }
  if (requiresHmuxSmoke !== true && requiresHmuxSmoke !== false) {
    throw new Error("CI verification plan smoke requirement must be boolean");
  }
  if (requiresHmuxArtifact !== true && requiresHmuxArtifact !== false) {
    throw new Error("CI verification plan artifact requirement must be boolean");
  }
  const normalizedScopes = normalizeScopes(scopes, "CI verification plan scopes");
  if (!isCanonicalScopeSet(scopes, normalizedScopes)) {
    throw new Error("CI verification plan scopes must be canonical");
  }
  const normalizedHead = normalizeCommitSha(verifiedHead, "verified head");
  if (normalizedHead !== normalizeCommitSha(expectedHead, "expected head")) {
    throw new Error("CI verification plan head does not match the current commit");
  }
  return {
    requiresHmuxArtifact,
    requiresHmuxSmoke,
    schema,
    scopes: normalizedScopes,
    verifiedBase: normalizeCommitSha(verifiedBase, "verified base"),
    verifiedHead: normalizedHead,
  };
}

export function createVerificationReceipt({
  capabilities = PRODUCT_CAPABILITIES,
  diagnostics,
  runId,
  scopes,
  verifiedBase,
  verifiedHead,
}) {
  const normalizedCapabilities = normalizeCapabilities(
    capabilities,
    PRODUCT_CAPABILITIES,
    "CI product verification capabilities",
  );
  if (!isCanonicalSet(normalizedCapabilities, PRODUCT_CAPABILITIES)) {
    throw new Error("CI product verification receipt must prove product-gate");
  }
  const receipt = {
    capabilities: normalizedCapabilities,
    runId: normalizeRunId(runId),
    schema: CI_VERIFICATION_SCHEMA,
    scopes: normalizeScopes(scopes),
    verifiedBase: normalizeCommitSha(verifiedBase, "verified base"),
    verifiedHead: normalizeCommitSha(verifiedHead, "verified head"),
  };
  return diagnostics === undefined
    ? receipt
    : {
        ...receipt,
        diagnostics: parseCompletedVerificationDiagnostics(diagnostics),
      };
}

const CAPABILITY_FINGERPRINT_HEX = /^[0-9a-f]{64}$/;

/** capability fingerprint 검증 — 있으면 형태를 강제하고, 없으면 undefined.
 *  (fingerprint 없는 구 영수증은 유효하지만 smoke 재사용 근거는 될 수 없다 —
 *  hmuxSmokeReuseDecision이 fail-closed로 거른다.) */
function normalizeCapabilityFingerprint(value) {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "object" ||
    !Number.isInteger(value.schemaVersion) ||
    typeof value.fingerprint !== "string" ||
    !CAPABILITY_FINGERPRINT_HEX.test(value.fingerprint)
  ) {
    throw new Error("CI behavior capability fingerprint is malformed");
  }
  return {
    schemaVersion: value.schemaVersion,
    fingerprint: value.fingerprint,
    ...(value.components === undefined
      ? {}
      : { components: normalizeFingerprintComponents(value.components) }),
  };
}

// hmux-smoke-fingerprint.mjs의 manifest 필드명과 1:1 — 정합은 그 모듈의
// hmuxSmokeFingerprintComponents가 파생으로, 계약 테스트가 검증으로 강제한다.
export const FINGERPRINT_COMPONENT_KEYS = Object.freeze([
  "entrypoints",
  "sources",
  "adapterSources",
  "runtimeSources",
  "harness",
  "toolchain",
  "os",
]);

// 진단 전용 부가 정보 — 판정 키는 전체 fingerprint 하나뿐이다. 존재한다면
// 형태는 강제한다: 부분·초과·오염된 breakdown은 없는 것보다 나쁘다.
// 미지 키를 조용히 버리면 새 컴포넌트 추가가 진단을 소리 없이 눈멀게 한다.
function normalizeFingerprintComponents(value) {
  if (typeof value !== "object" || value === null) {
    throw new Error("CI behavior fingerprint components are malformed");
  }
  const known = new Set(FINGERPRINT_COMPONENT_KEYS);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new Error("CI behavior fingerprint components are malformed");
    }
  }
  const normalized = {};
  for (const key of FINGERPRINT_COMPONENT_KEYS) {
    if (
      typeof value[key] !== "string" ||
      !CAPABILITY_FINGERPRINT_HEX.test(value[key])
    ) {
      throw new Error("CI behavior fingerprint components are malformed");
    }
    normalized[key] = value[key];
  }
  return normalized;
}

/** 재사용 불발 진단(순수) — 동일 schemaVersion의 breakdown 있는 가장 최근
 *  genuine 영수증과 현재 컴포넌트를 대조해 어느 입력군이 달라졌는지
 *  서술한다. 다른 스키마의 컴포넌트 해시는 계산 자체가 달라 비교 불능이므로
 *  기준에서 제외한다. 판정에 관여하지 않으며 로그 한 줄의 원료다. */
export function describeFingerprintMismatch(
  { schemaVersion, components },
  candidateReceipts,
) {
  let newest;
  for (const raw of candidateReceipts ?? []) {
    let candidate = raw;
    if (typeof raw === "string") {
      try {
        candidate = parseBehaviorReceipt(raw);
      } catch {
        continue;
      }
    }
    const fp = candidate?.capabilityFingerprint;
    if (!fp?.components) continue;
    if (fp.schemaVersion !== schemaVersion) continue;
    if (candidate.reusedFromRunId) continue;
    if (newest && Number(newest.runId) >= Number(candidate.runId)) continue;
    newest = candidate;
  }
  if (!newest) {
    return "no same-schema genuine candidate carries a component breakdown";
  }
  const diverged = FINGERPRINT_COMPONENT_KEYS.filter(
    (key) => newest.capabilityFingerprint.components[key] !== components?.[key],
  );
  if (diverged.length === 0) {
    return `components identical to run ${newest.runId} yet fingerprints differ — schema drift suspected`;
  }
  return `diverged from run ${newest.runId} in: ${diverged.join(", ")}`;
}

export function createBehaviorReceipt({
  capabilities = BEHAVIOR_CAPABILITIES,
  capabilityFingerprint,
  reusedFromRunId,
  runId,
  verifiedHead,
}) {
  const normalizedCapabilities = normalizeCapabilities(
    capabilities,
    BEHAVIOR_CAPABILITIES,
    "CI behavior capabilities",
  );
  if (!isCanonicalSet(normalizedCapabilities, BEHAVIOR_CAPABILITIES)) {
    throw new Error(
      "CI behavior receipt must prove hmux-background-smoke",
    );
  }
  const fingerprint = normalizeCapabilityFingerprint(capabilityFingerprint);
  // reusedFromRunId: 이 영수증이 실제 smoke 실행이 아니라 동일 fingerprint의
  // 이전 실행(genuine run)을 근거로 발행됐음을 기록한다. 재사용 영수증은
  // 커버리지 이력으로는 유효하지만 미래 재사용의 근거는 될 수 없다
  // (hmuxSmokeReuseDecision이 제외) — 사슬 길이를 실제 실행 1홉으로 묶는다.
  const reusedFrom =
    reusedFromRunId === undefined || reusedFromRunId === ""
      ? undefined
      : normalizeRunId(reusedFromRunId);
  return {
    capabilities: normalizedCapabilities,
    ...(fingerprint ? { capabilityFingerprint: fingerprint } : {}),
    ...(reusedFrom ? { reusedFromRunId: reusedFrom } : {}),
    runId: normalizeRunId(runId),
    schema: CI_BEHAVIOR_RECEIPT_SCHEMA,
    verifiedHead: normalizeCommitSha(verifiedHead, "verified head"),
  };
}

/** smoke 재사용 판정 (2단계 활성화의 순수 핵심) — fail-closed:
 *  현재 fingerprint가 없거나, 후보 영수증에 fingerprint가 없거나, schema
 *  버전이 다르거나, 값이 다르면 재사용 불가. 일치하는 가장 최근 runId를
 *  근거로 돌려준다. */
export function hmuxSmokeReuseDecision({ currentFingerprint, candidateReceipts }) {
  if (
    typeof currentFingerprint !== "object" ||
    currentFingerprint === null ||
    !CAPABILITY_FINGERPRINT_HEX.test(currentFingerprint.fingerprint ?? "")
  ) {
    return { reuse: false, reason: "current_fingerprint_unavailable" };
  }
  const matches = [];
  for (const candidate of candidateReceipts ?? []) {
    let receipt;
    try {
      receipt = parseBehaviorReceipt(
        typeof candidate === "string" ? candidate : JSON.stringify(candidate),
      );
    } catch {
      continue; // 깨진 영수증은 근거가 아니다
    }
    const fp = receipt.capabilityFingerprint;
    if (!fp) continue;
    if (fp.schemaVersion !== currentFingerprint.schemaVersion) continue;
    if (fp.fingerprint !== currentFingerprint.fingerprint) continue;
    // 재사용 영수증은 근거가 아니다 — 모든 재사용은 실제 실행에 직접
    // 앵커링해야 하며(1홉), 무한 전이 사슬은 daily canary가 아니라 여기서
    // 구조적으로 차단한다.
    if (receipt.reusedFromRunId) continue;
    matches.push(receipt);
  }
  if (matches.length === 0) {
    return { reuse: false, reason: "no_matching_receipt" };
  }
  // runId는 자릿수가 다른 숫자 문자열일 수 있다 — 사전순 비교 금지.
  matches.sort((left, right) => Number(right.runId) - Number(left.runId));
  return { reuse: true, source: matches[0] };
}

/** behavior 영수증 아티팩트 하나를 내려받아 파싱한다. 실패는 모두 null —
 *  깨진 아티팩트는 근거가 아닐 뿐 판정 자체를 죽이지 않는다. */
export async function downloadBehaviorReceipt(run, repository, record) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "dure-ci-behavior-receipt-"),
  );
  try {
    const artifactId = String(record?.artifactId ?? "");
    if (!/^[1-9][0-9]*$/.test(artifactId)) return null;
    const archivePath = path.join(directory, "receipt.zip");
    const downloaded = await run(
      "gh",
      ["api", `repos/${repository}/actions/artifacts/${artifactId}/zip`],
      { encoding: "buffer", maxBuffer: 1024 * 1024 },
    );
    if (downloaded.status !== 0 || !Buffer.isBuffer(downloaded.stdout)) {
      return null;
    }
    fs.writeFileSync(archivePath, downloaded.stdout, { mode: 0o600 });
    const extracted = await run(
      "unzip",
      ["-p", archivePath, CI_VERIFICATION_RECEIPT_FILE],
      { maxBuffer: 1024 * 1024 },
    );
    if (extracted.status !== 0 || typeof extracted.stdout !== "string") {
      return null;
    }
    return parseBehaviorReceipt(extracted.stdout);
  } catch {
    return null;
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function parseLegacyVerificationReceipt(parsed) {
  if (parsed.scope !== "full" && parsed.scope !== "frontend") {
    throw new Error("legacy CI verification scope must be full or frontend");
  }
  return {
    runId: normalizeRunId(parsed.runId),
    schema: LEGACY_CI_VERIFICATION_SCHEMA,
    scope: parsed.scope,
    verifiedBase: normalizeCommitSha(parsed.verifiedBase, "verified base"),
    verifiedHead: normalizeCommitSha(parsed.verifiedHead, "verified head"),
  };
}

function parsePreCapabilityVerificationReceipt(parsed) {
  const receipt = {
    runId: normalizeRunId(parsed.runId),
    schema: PRE_CAPABILITY_CI_VERIFICATION_SCHEMA,
    scopes: normalizeScopes(parsed.scopes),
    verifiedBase: normalizeCommitSha(parsed.verifiedBase, "verified base"),
    verifiedHead: normalizeCommitSha(parsed.verifiedHead, "verified head"),
  };
  if (!isCanonicalScopeSet(parsed.scopes, receipt.scopes)) {
    throw new Error("CI verification scopes must be canonical");
  }
  return parsed.diagnostics === undefined
    ? receipt
    : {
        ...receipt,
        diagnostics: parseCompletedVerificationDiagnostics(
          parsed.diagnostics,
        ),
      };
}

export function parseVerificationReceipt(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid CI verification receipt JSON: ${error.message}`);
  }

  if (parsed?.schema === LEGACY_CI_VERIFICATION_SCHEMA) {
    return parseLegacyVerificationReceipt(parsed);
  }
  if (parsed?.schema === PRE_CAPABILITY_CI_VERIFICATION_SCHEMA) {
    return parsePreCapabilityVerificationReceipt(parsed);
  }
  if (parsed?.schema !== CI_VERIFICATION_SCHEMA) {
    throw new Error("unsupported CI verification receipt schema");
  }

  const receipt = createVerificationReceipt(parsed);
  if (!isCanonicalSet(parsed.capabilities, receipt.capabilities)) {
    throw new Error("CI product verification capabilities must be canonical");
  }
  if (!isCanonicalScopeSet(parsed.scopes, receipt.scopes)) {
    throw new Error("CI verification scopes must be canonical");
  }
  return receipt;
}

export function parseBehaviorReceipt(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid CI behavior receipt JSON: ${error.message}`);
  }
  if (parsed?.schema !== CI_BEHAVIOR_RECEIPT_SCHEMA) {
    throw new Error("unsupported CI behavior receipt schema");
  }
  const receipt = createBehaviorReceipt(parsed);
  if (!isCanonicalSet(parsed.capabilities, receipt.capabilities)) {
    throw new Error("CI behavior capabilities must be canonical");
  }
  return receipt;
}

export function receiptProvesProductGate(receipt) {
  return (
    receipt?.schema === CI_VERIFICATION_SCHEMA &&
    isCanonicalSet(receipt.capabilities, PRODUCT_CAPABILITIES)
  );
}

export function receiptMatchesRun(receipt, record) {
  if (!receipt || !record) {
    return false;
  }
  try {
    return (
      receipt.runId === normalizeRunId(record.databaseId) &&
      receipt.verifiedHead === normalizeCommitSha(record.headSha, "run head")
    );
  } catch {
    return false;
  }
}

export function observedVerificationScopes(receipt) {
  try {
    if (
      receipt?.schema === CI_VERIFICATION_SCHEMA ||
      receipt?.schema === PRE_CAPABILITY_CI_VERIFICATION_SCHEMA
    ) {
      const canonical = normalizeScopes(receipt.scopes);
      return isCanonicalScopeSet(receipt.scopes, canonical) ? canonical : [];
    }
    if (receipt?.schema === LEGACY_CI_VERIFICATION_SCHEMA) {
      if (receipt.scope === "frontend") {
        return ["frontend"];
      }
      if (receipt.scope === "full") {
        return [...LEGACY_FULL_SCOPES];
      }
    }
  } catch {
    // Malformed evidence proves no scope.
  }
  return [];
}

export function verificationScopesSatisfy(requiredScopes, observedScopes) {
  try {
    const required = normalizeScopes(requiredScopes, "required scopes");
    const observed = new Set(
      normalizeScopes(observedScopes, "observed scopes"),
    );
    return required.every((scope) => observed.has(scope));
  } catch {
    return false;
  }
}

export async function downloadVerificationReceipt(run, repository, record) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hebbian-ci-verification-"),
  );
  try {
    const artifactId = String(record?.artifactId ?? "");
    if (/^[1-9][0-9]*$/.test(artifactId)) {
      const archivePath = path.join(directory, "receipt.zip");
      const downloaded = await run(
        "gh",
        [
          "api",
          `repos/${repository}/actions/artifacts/${artifactId}/zip`,
        ],
        { encoding: "buffer", maxBuffer: 1024 * 1024 },
      );
      if (downloaded.status !== 0 || !Buffer.isBuffer(downloaded.stdout)) {
        return null;
      }
      fs.writeFileSync(archivePath, downloaded.stdout, { mode: 0o600 });
      const extracted = await run(
        "unzip",
        ["-p", archivePath, CI_VERIFICATION_RECEIPT_FILE],
        { maxBuffer: 1024 * 1024 },
      );
      if (extracted.status !== 0 || typeof extracted.stdout !== "string") {
        return null;
      }
      return parseVerificationReceipt(extracted.stdout);
    }

    for (const artifact of [
      CI_PRODUCT_VERIFICATION_ARTIFACT,
      PRE_CAPABILITY_CI_VERIFICATION_ARTIFACT,
    ]) {
      fs.rmSync(path.join(directory, CI_VERIFICATION_RECEIPT_FILE), {
        force: true,
      });
      const result = await run("gh", [
        "run",
        "download",
        String(record.databaseId),
        "--repo",
        repository,
        "--name",
        artifact,
        "--dir",
        directory,
      ]);
      if (result.status !== 0) continue;
      try {
        const source = fs.readFileSync(
          path.join(directory, CI_VERIFICATION_RECEIPT_FILE),
          "utf8",
        );
        return parseVerificationReceipt(source);
      } catch {
        // A malformed artifact proves nothing; try only the legacy name.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function isGreen(record) {
  return record?.status === "completed" && record?.conclusion === "success";
}

function hasListedProductArtifact(record) {
  return /^[1-9][0-9]*$/.test(String(record?.artifactId ?? ""));
}

function fallbackVerifiedBase(fallbackBase, head, isAncestor) {
  try {
    const base = normalizeCommitSha(fallbackBase, "fallback base");
    return isAncestor(base, head) ? base : head;
  } catch {
    return head;
  }
}

function isAllScopesReceipt(receipt) {
  return verificationScopesSatisfy(
    ALL_VERIFICATION_SCOPES,
    observedVerificationScopes(receipt),
  );
}

/**
 * Validate the durable product-gate proof chain.
 *
 * Capability-bearing v3 receipts remain valid when a later behavior smoke
 * fails. Pre-capability v2 evidence is accepted only from a green workflow,
 * preserving its historical all-gates-success meaning.
 *
 * An all-scope receipt is a complete anchor because it verifies the whole tree
 * at its head. A partial receipt becomes complete only after its exact base is
 * already complete and its declared scopes cover the classifier result for
 * that base..head range. Candidates may arrive newest-first, so partial
 * receipts are resolved to a fixed point rather than trusted in list order.
 */
export async function validatedCompleteVerificationReceipts({
  changedPaths,
  head: headInput,
  isAncestor,
  loadReceipt,
  records,
}) {
  const head = normalizeCommitSha(headInput, "verification head");
  const candidates = [];
  let completeAnchorHeads = [];

  const isCoveredByAnchor = (candidateHead) =>
    completeAnchorHeads.some((anchorHead) =>
      isAncestor(candidateHead, anchorHead),
    );

  const loadSafely = async (record) => {
    try {
      return await loadReceipt(record);
    } catch {
      return null;
    }
  };

  const acceptLoadedReceipt = (record, candidateHead, loadedReceipt) => {
    try {
      if (!loadedReceipt || isCoveredByAnchor(candidateHead)) return;
      const receipt = parseVerificationReceipt(JSON.stringify(loadedReceipt));
      const productCapability = receiptProvesProductGate(receipt);
      const greenPreCapability =
        receipt.schema === PRE_CAPABILITY_CI_VERIFICATION_SCHEMA &&
        isGreen(record);
      if (!productCapability && !greenPreCapability) return;
      if (
        !receiptMatchesRun(receipt, record) ||
        !isAncestor(receipt.verifiedBase, receipt.verifiedHead)
      ) {
        return;
      }
      candidates.push({
        head: candidateHead,
        observedScopes: observedVerificationScopes(receipt),
        receipt,
        record,
      });
      if (isAllScopesReceipt(receipt)) {
        completeAnchorHeads = completeAnchorHeads.filter(
          (anchorHead) => !isAncestor(anchorHead, candidateHead),
        );
        completeAnchorHeads.push(candidateHead);
      }
    } catch {
      // Unreadable evidence cannot join the complete chain.
    }
  };

  const processSequentially = async (record) => {
    try {
      // A v3 product artifact is durable as soon as its upload step completes,
      // even while a later behavior smoke is still running. Failed, cancelled,
      // and in-progress workflows usually have no reusable proof, so probe for
      // it before spending ancestry work unless the artifact-list endpoint
      // already supplied its exact id. Listed artifacts retain the cheaper
      // ancestry-first path without pretending their workflow was green.
      const probeBeforeAncestry =
        !isGreen(record) && !hasListedProductArtifact(record);
      let loadedReceipt = probeBeforeAncestry
        ? await loadSafely(record)
        : undefined;
      if (probeBeforeAncestry && !loadedReceipt) return;
      const candidateHead = normalizeCommitSha(record.headSha, "run head");
      if (!isAncestor(candidateHead, head) || isCoveredByAnchor(candidateHead)) {
        return;
      }
      loadedReceipt ??= await loadSafely(record);
      acceptLoadedReceipt(record, candidateHead, loadedReceipt);
    } catch {
      // Invalid metadata proves nothing.
    }
  };

  const processListedBatch = async (batch) => {
    const eligible = [];
    for (const record of batch) {
      try {
        const candidateHead = normalizeCommitSha(record.headSha, "run head");
        if (
          isAncestor(candidateHead, head) &&
          !isCoveredByAnchor(candidateHead)
        ) {
          eligible.push({ candidateHead, record });
        }
      } catch {
        // Invalid metadata proves nothing.
      }
    }
    const loadedReceipts = await Promise.all(
      eligible.map(({ record }) => loadSafely(record)),
    );
    for (let index = 0; index < eligible.length; index += 1) {
      const { candidateHead, record } = eligible[index];
      acceptLoadedReceipt(record, candidateHead, loadedReceipts[index]);
    }
  };

  const sourceRecords = Array.isArray(records) ? records : [];
  if (sourceRecords.length > 0) {
    // Preserve the newest receipt's all-scope early exit before speculatively
    // loading any older artifacts.
    await processSequentially(sourceRecords[0]);
  }
  for (let index = 1; index < sourceRecords.length; ) {
    if (!hasListedProductArtifact(sourceRecords[index])) {
      await processSequentially(sourceRecords[index]);
      index += 1;
      continue;
    }
    const batch = [];
    while (
      index < sourceRecords.length &&
      batch.length < RECEIPT_LOAD_BATCH_SIZE &&
      hasListedProductArtifact(sourceRecords[index])
    ) {
      batch.push(sourceRecords[index]);
      index += 1;
    }
    await processListedBatch(batch);
  }

  const completeHeads = new Set();
  const completeCandidates = new Set();
  for (const candidate of candidates) {
    if (isAllScopesReceipt(candidate.receipt)) {
      completeCandidates.add(candidate);
      completeHeads.add(candidate.head);
    }
  }

  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const candidate of candidates) {
      if (
        completeCandidates.has(candidate) ||
        !completeHeads.has(candidate.receipt.verifiedBase)
      ) {
        continue;
      }
      try {
        const paths = await changedPaths(
          candidate.receipt.verifiedBase,
          candidate.receipt.verifiedHead,
        );
        const requiredScopes = classifyVerificationScopes(paths);
        if (
          !verificationScopesSatisfy(
            requiredScopes,
            candidate.observedScopes,
          )
        ) {
          continue;
        }
        completeCandidates.add(candidate);
        completeHeads.add(candidate.head);
        advanced = true;
      } catch {
        // A diff failure leaves this candidate incomplete.
      }
    }
  }

  return candidates.filter((candidate) => completeCandidates.has(candidate));
}

function newestCompleteReceipt(candidates, isAncestor) {
  try {
    const maximal = candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) =>
            other.head !== candidate.head &&
            isAncestor(candidate.head, other.head),
        ),
    );
    return maximal[0];
  } catch {
    return undefined;
  }
}

export async function determineVerificationPlan({
  changedPaths,
  fallbackBase,
  head: headInput,
  isAncestor,
  loadReceipt,
  records,
}) {
  const head = normalizeCommitSha(headInput, "verification head");
  let completeReceipts = [];
  try {
    completeReceipts = await validatedCompleteVerificationReceipts({
      changedPaths,
      head,
      isAncestor,
      loadReceipt,
      records,
    });
  } catch {
    // Missing, stale, or malformed evidence can only widen verification.
  }
  const watermark = newestCompleteReceipt(completeReceipts, isAncestor)?.head;

  if (!watermark) {
    const scopes = [...ALL_VERIFICATION_SCOPES];
    return {
      reason: "no-all-scopes-watermark",
      requiresHmuxArtifact: true,
      requiresHmuxSmoke: true,
      scopes,
      verifiedBase: fallbackVerifiedBase(fallbackBase, head, isAncestor),
      verifiedHead: head,
    };
  }

  try {
    const paths = await changedPaths(watermark, head);
    const scopes = classifyVerificationScopes(paths);
    return {
      reason: "complete-watermark",
      requiresHmuxArtifact: requiresHmuxArtifact(paths),
      requiresHmuxSmoke: requiresHmuxBackgroundSmoke(paths),
      scopes,
      verifiedBase: watermark,
      verifiedHead: head,
    };
  } catch {
    const scopes = [...ALL_VERIFICATION_SCOPES];
    return {
      reason: "diff-unavailable",
      requiresHmuxArtifact: true,
      requiresHmuxSmoke: true,
      scopes,
      verifiedBase: watermark,
      verifiedHead: head,
    };
  }
}
