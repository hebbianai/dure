import { createClaudeAgentSdkQueryFactory } from "./agent-sdk-query.mjs";
import { createClaudeAgentSdkHistoryReader } from "./agent-sdk-history.mjs";
import { claudeRuntimeArtifactDescriptor } from "./claude-runtime-artifact.mjs";
import { ensureClaudeRuntimeArtifact } from "./claude-runtime-provision.mjs";
import { loadPinnedClaudeSdkRuntime } from "./sdk-runtime.mjs";
import { startSharedClaudeSdkHostServer } from "./shared-sdk-host-server.mjs";

export async function startProductionSharedClaudeSdkHost(options) {
	const runtime = await loadPinnedClaudeSdkRuntime();
	let descriptor = null;
	let queryFactory;
	const server = await startSharedClaudeSdkHostServer({
		...options,
		async createQuery(context) {
			queryFactory ??= ensureClaudeRuntimeArtifact({
				claudeCodeVersion: runtime.metadata.claudeCodeVersion,
				runtimeRoot: options?.runtimeRoot,
				runtimeSource: runtime.runtimeSource,
				sdkVersion: runtime.metadata.sdkVersion,
			})
				.then((runtimeArtifact) => {
					descriptor = claudeRuntimeArtifactDescriptor(runtimeArtifact);
					return createClaudeAgentSdkQueryFactory({
						claudeCodeVersion: runtime.metadata.claudeCodeVersion,
						runtimeArtifact,
						sdkVersion: runtime.metadata.sdkVersion,
						startup: runtime.startup,
						usageLimitErrorPrefixes: runtime.usageLimitErrorPrefixes,
					});
				})
				.catch((error) => {
					queryFactory = undefined;
					throw error;
				});
			const createQuery = await queryFactory;
			return createQuery(context);
		},
		readHistory: createClaudeAgentSdkHistoryReader({
			getSessionMessages: runtime.getSessionMessages,
		}),
	});
	return Object.freeze({
		get runtime() {
			return descriptor;
		},
		sdk: runtime.metadata,
		server,
	});
}
