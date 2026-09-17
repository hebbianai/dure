import { shallow } from "zustand/shallow";
import type { HmuxSessionSummary } from "@/lib/ipc/hmuxContracts";

type Metadata = Readonly<Record<string, HmuxSessionSummary>>;
type Labels = Record<string, string | undefined>;

/** One current projection per subscriber. The runtime store replaces metadata
 * on every change; unrelated publications can reuse the exact same projection.
 * Output-only changes still compare the two fields Spaces actually displays.
 */
export function createSpacesSessionMetadataSelector() {
	let source: Metadata | undefined;
	let projection = {
		hostBuildByMetadataKey: {} as Labels,
		sessionNameByMetadataKey: {} as Labels,
	};
	return ({ hmuxSessionMetadata }: { hmuxSessionMetadata: Metadata }) => {
		if (source === hmuxSessionMetadata) return projection;
		const hostBuildByMetadataKey: Labels = {};
		const sessionNameByMetadataKey: Labels = {};
		for (const [key, metadata] of Object.entries(hmuxSessionMetadata)) {
			hostBuildByMetadataKey[key] = metadata.hostBuildVersion;
			sessionNameByMetadataKey[key] = metadata.sessionName;
		}
		if (
			!shallow(projection.hostBuildByMetadataKey, hostBuildByMetadataKey) ||
			!shallow(projection.sessionNameByMetadataKey, sessionNameByMetadataKey)
		) {
			projection = { hostBuildByMetadataKey, sessionNameByMetadataKey };
		}
		source = hmuxSessionMetadata;
		return projection;
	};
}
