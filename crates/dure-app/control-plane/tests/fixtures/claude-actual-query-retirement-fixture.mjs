#!/usr/bin/env node

import fs from "node:fs";
import { createClaudeAgentSdkQueryFactory } from "../../provider-drivers/claude/agent-sdk-query.mjs";
import { ensureClaudeRuntimeArtifact } from "../../provider-drivers/claude/claude-runtime-provision.mjs";
import { loadPinnedClaudeSdkRuntime } from "../../provider-drivers/claude/sdk-runtime.mjs";
import {
	readRetiredSdkHostIdentities,
	serveSharedSdkHostProcess,
	sharedSdkHostProcessArguments,
} from "../../provider-drivers/claude/shared-sdk-host-process.mjs";
import { startSharedClaudeSdkHostServer } from "../../provider-drivers/claude/shared-sdk-host-server.mjs";

const options = sharedSdkHostProcessArguments(process.argv.slice(2));
const runtime = await loadPinnedClaudeSdkRuntime();
const runtimeArtifact = await ensureClaudeRuntimeArtifact({
	claudeCodeVersion: runtime.metadata.claudeCodeVersion,
	runtimeRoot: options.runtimeRoot,
	runtimeSource: runtime.runtimeSource,
	sdkVersion: runtime.metadata.sdkVersion,
});
const server = await startSharedClaudeSdkHostServer({
	capabilityFile: options.capabilityFile,
	endpoint: options.endpoint,
	hostGeneration: options.hostGeneration,
	retiredIdentities: readRetiredSdkHostIdentities(options.retiredIdentitiesFile),
	createQuery: createClaudeAgentSdkQueryFactory({
		claudeCodeVersion: runtime.metadata.claudeCodeVersion,
		runtimeArtifact,
		sdkVersion: runtime.metadata.sdkVersion,
		usageLimitErrorPrefixes: runtime.usageLimitErrorPrefixes,
		async startup(input) {
			const warm = await runtime.startup(input);
			return {
				close: () => warm.close(),
				query(messages) {
					const query = warm.query(messages);
					return new Proxy(query, {
						get(target, key) {
							if (key === "close") {
								return () => {
									// Count every actual SDK close invocation, including duplicates.
									fs.appendFileSync(process.env.DURE_QUERY_CLOSE_COUNT_FILE, "x", {
										mode: 0o600,
									});
									return target.close();
								};
							}
							const value = Reflect.get(target, key, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
				},
			};
		},
	}),
});
await serveSharedSdkHostProcess({ fixture: true, options, sdk: runtime.metadata, server });
