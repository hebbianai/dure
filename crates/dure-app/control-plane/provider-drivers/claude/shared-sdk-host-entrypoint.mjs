#!/usr/bin/env node

import {
	readRetiredSdkHostIdentities,
	serveSharedSdkHostProcess,
	sharedSdkHostProcessArguments,
} from "./shared-sdk-host-process.mjs";
import { startProductionSharedClaudeSdkHost } from "./shared-sdk-host-production.mjs";

const options = sharedSdkHostProcessArguments(process.argv.slice(2));
const production = await startProductionSharedClaudeSdkHost({
	capabilityFile: options.capabilityFile,
	endpoint: options.endpoint,
	hostGeneration: options.hostGeneration,
	retiredIdentities: readRetiredSdkHostIdentities(options.retiredIdentitiesFile),
	runtimeRoot: options.runtimeRoot,
});
await serveSharedSdkHostProcess({
	fixture: false,
	options,
	get runtime() {
		return production.runtime;
	},
	sdk: production.sdk,
	server: production.server,
});
