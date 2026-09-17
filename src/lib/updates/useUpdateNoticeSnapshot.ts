import { useSyncExternalStore } from "react";
import {
	subscribeUpdateNotices,
	type UpdateNoticeSnapshot,
	updateNoticeSnapshot,
} from "@/lib/updates/updateNotice";

/** Subscribe React surfaces to the source-neutral update projection. */
export function useUpdateNoticeSnapshot(): UpdateNoticeSnapshot {
	return useSyncExternalStore(
		subscribeUpdateNotices,
		updateNoticeSnapshot,
		updateNoticeSnapshot,
	);
}
