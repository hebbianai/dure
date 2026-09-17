export type ManagedAgentInputDeliveryState =
	| "not_written"
	| "body_written_submit_unknown"
	| "unknown";

export class ManagedAgentInputError extends Error {
	/** Whether the input body reached the PTY before submission failed. */
	bodyDelivered = false;
	/** Whether retry is definitely safe at the Host input boundary. */
	deliveryState: ManagedAgentInputDeliveryState = "unknown";

	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ManagedAgentInputError";
	}
}
