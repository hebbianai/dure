import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";
import { SharedAgentConversation } from "@/components/agents/chat/SharedAgentConversation";
import { LoadingStatus } from "@/components/common/PanelStatus";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	openSharedAgentConversation,
	type SharedAgentConversationReference,
	type SharedAgentConversationTarget,
} from "@/lib/agents/chat/sharedAgentConversation";
import { t } from "@/lib/i18n";

export interface SharedConversationPanelParams {
	reference: SharedAgentConversationReference;
	profileId: string;
}

/** Only identity is persisted in the layout. A restored pane resolves its
 * current conversation and route from the server before mounting the chat. */
export function SharedConversationPanel({
	params,
}: IDockviewPanelProps<SharedConversationPanelParams>) {
	const [target, setTarget] = useState<SharedAgentConversationTarget>();
	const [error, setError] = useState(false);
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		let current = true;
		setTarget(undefined);
		setError(false);
		void openSharedAgentConversation(params.reference, params.profileId)
			.then((next) => {
				if (current) setTarget(next);
			})
			.catch(() => {
				if (current) setError(true);
			});
		return () => {
			current = false;
		};
	}, [params.reference, params.profileId, revision]);
	if (error)
		return (
			<div className="p-4">
				<Alert>{t("tag.openFailed")}</Alert>
				<Button
					variant="ghost"
					onClick={() => setRevision((value) => value + 1)}
				>
					{t("common.retry")}
				</Button>
			</div>
		);
	return target ? (
		<SharedAgentConversation target={target} />
	) : (
		<LoadingStatus />
	);
}
