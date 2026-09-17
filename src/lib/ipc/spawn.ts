// ipc/spawn — 스폰 사가 저널 (UC-04).
//
// ipc.ts 도메인 분할 1단계(2026-08-01): 내용은 구 src/lib/ipc.ts에서 그대로
// 옮겨졌고, 소비자는 barrel(src/lib/ipc.ts)을 통해 기존 경로를 유지한다.
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).
import { invoke } from "@tauri-apps/api/core";
import type { HmuxInitialAgentPromptReceipt } from "./hmuxContracts";

// ---------- spawn saga journal (UC-04) ----------

export type SpawnPromptDeliveryFailureState = "not_written" | "unknown";

export interface SpawnReceiptStepError {
	code: string;
	message: string;
	deliveryState?: SpawnPromptDeliveryFailureState;
}

export interface SpawnReceiptStep {
	step: string;
	status: "pending" | "running" | "ok" | "failed" | "skipped";
	startedAt?: number;
	endedAt?: number;
	artifacts?: Array<Record<string, unknown>>;
	evidence?: { level: string; detail?: string };
	delivery?: {
		state: "intent_durable" | "written_to_pty" | "unverified";
		promptDigest?: string;
		promptLen?: number;
		receipt?: HmuxInitialAgentPromptReceipt;
	};
	error?: SpawnReceiptStepError;
	detail?: unknown;
}

export interface SpawnReceipt {
	v: number;
	receiptId: string;
	idempotencyKey?: string | null;
	request: Record<string, unknown> | null;
	steps: SpawnReceiptStep[];
	state: string;
	updatedAt: number;
}

/** Rust assigns seq/at and fsyncs the journal;
 * receipts are in-memory folds of that authority. */
export const spawnJournal = {
	append: (receiptId: string, event: Record<string, unknown>) =>
		invoke<SpawnReceipt>("spawn_journal_append", { receiptId, event }),
	receipt: (receiptId: string) =>
		invoke<SpawnReceipt>("spawn_receipt_get", { receiptId }),
	findByIdempotencyKey: (idempotencyKey: string) =>
		invoke<SpawnReceipt | null>("spawn_receipt_find", { idempotencyKey }),
	listRunning: () => invoke<SpawnReceipt[]>("spawn_receipts_list_running"),
	/** Journal-first saga creation: the backend fsyncs the request before any
	 *  execution, so a submission is durable the moment this resolves — the
	 *  same crash-safety property as POST /spawn/v2, without the HTTP hop. */
	createSaga: (request: Record<string, unknown>, idempotencyKey?: string) =>
		invoke<{ receiptId: string; existing?: boolean }>("spawn_saga_create", {
			request,
			idempotencyKey: idempotencyKey ?? null,
		}),
};
