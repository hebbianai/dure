import type {
	IssueTrackerWatchEventV1,
	IssueTrackerWatchSubscriptionV1,
} from "@/contracts/generated/extensionContracts";

type WatchReceipt =
	| { kind: "pending"; latest: IssueTrackerWatchEventV1 | null }
	| { kind: "acknowledged"; generation: number };

/** One receiver per subscribe attempt. Native generation scopes revision order;
 * a retained UI snapshot must never lend its cursor to a replacement lease. */
export class IssueTrackerWatchReceiver {
	private receipt: WatchReceipt = { kind: "pending", latest: null };
	private cursor: { generation: number; revision: number } | null = null;

	constructor(
		private readonly identity: {
			pluginId: string;
			contributionId: string;
			workspaceKey: string;
		},
	) {}

	get generation(): number | null {
		return this.receipt.kind === "acknowledged"
			? this.receipt.generation
			: null;
	}

	/** Keeps order for a reused native generation, without retaining pending
	 * events or the acknowledgement of the previous subscribe attempt. */
	renew(): IssueTrackerWatchReceiver {
		const receiver = new IssueTrackerWatchReceiver(this.identity);
		receiver.cursor = this.cursor;
		return receiver;
	}

	receive(event: IssueTrackerWatchEventV1): IssueTrackerWatchEventV1 | null {
		if (
			event.plugin_id !== this.identity.pluginId ||
			event.contribution_id !== this.identity.contributionId ||
			event.workspace_key !== this.identity.workspaceKey
		)
			return null;
		if (this.receipt.kind === "pending") {
			const previous = this.receipt.latest;
			if (
				!previous ||
				event.generation > previous.generation ||
				(event.generation === previous.generation &&
					event.revision > previous.revision)
			) {
				this.receipt.latest = event;
			}
			return null;
		}
		if (
			event.generation !== this.receipt.generation ||
			(this.cursor?.generation === event.generation &&
				event.revision <= this.cursor.revision)
		)
			return null;
		this.cursor = { generation: event.generation, revision: event.revision };
		return event;
	}

	acknowledge(
		subscription: IssueTrackerWatchSubscriptionV1,
	): IssueTrackerWatchEventV1[] {
		if (this.receipt.kind !== "pending") return [];
		const pending = this.receipt.latest;
		this.receipt = {
			kind: "acknowledged",
			generation: subscription.generation,
		};
		const accepted: IssueTrackerWatchEventV1[] = [];
		for (const event of [subscription.latest, pending]) {
			const next = event && this.receive(event);
			if (next) accepted.push(next);
		}
		return accepted;
	}
}
