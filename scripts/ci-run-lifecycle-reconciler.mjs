#!/usr/bin/env node

import {
	createGitHubActionsClient,
	reconcileQueuedCiRuns,
} from "./lib/ci-run-lifecycle-reconciler.mjs";

try {
	const reconciled = await reconcileQueuedCiRuns({
		client: createGitHubActionsClient({
			apiUrl: process.env.GITHUB_API_URL,
			repository: process.env.GITHUB_REPOSITORY,
			token: process.env.GH_TOKEN,
		}),
	});
	process.stdout.write(
		`${JSON.stringify({ schemaVersion: 1, reconciled })}\n`,
	);
} catch (error) {
	process.stderr.write(
		`ci-run-lifecycle-reconciler: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
