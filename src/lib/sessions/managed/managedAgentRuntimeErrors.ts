import type { HmuxRecoveryExecutionReceipt } from "@/lib/ipc";

export class ManagedCredentialReferenceError extends Error {
	readonly code = "credential_reference_unavailable";

	constructor(credentialId: string) {
		super(`credential reference is unavailable: ${credentialId}`);
		this.name = "ManagedCredentialReferenceError";
	}
}

export class ManagedCredentialReferenceChangedError extends Error {
	readonly code = "credential_reference_changed";

	constructor(credentialId: string) {
		super(`credential reference changed during preflight: ${credentialId}`);
		this.name = "ManagedCredentialReferenceChangedError";
	}
}

export class ManagedRecoveryRefusedError extends Error {
	readonly receipt?: HmuxRecoveryExecutionReceipt;

	/** `detail`은 코드가 아니라 관측 사유다. `code`는 호출부가 분기에 쓰므로
	 *  순수한 코드로 남기고, 사람이 읽는 메시지에만 붙인다. */
	constructor(
		readonly code: string,
		options: {
			receipt?: HmuxRecoveryExecutionReceipt;
			detail?: string;
		} = {},
	) {
		const detail = options.detail?.trim();
		super(
			`managed Hmux recovery was refused: ${
				detail && detail !== code ? detail : code
			}`,
		);
		this.name = "ManagedRecoveryRefusedError";
		this.receipt = options.receipt;
	}
}
