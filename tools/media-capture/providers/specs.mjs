const PROVIDER_PROMPT =
  "Inspect this demo repository read-only. Trace the session handoff code, run the focused tests, and report one concrete race-condition safeguard. Do not edit files.";

function optionalModelArgs(flag, value) {
  return value ? [flag, value] : [];
}

export function providerSpec(provider, env = process.env) {
  switch (provider) {
    case "codex":
      return {
        executable: env.DURE_MEDIA_CODEX_BIN || "codex",
        args: [
          "--sandbox",
          "read-only",
          "--ask-for-approval",
          "never",
          ...optionalModelArgs("--model", env.DURE_MEDIA_CODEX_MODEL),
        ],
        prompt: PROVIDER_PROMPT,
      };
    case "claude":
      return {
        executable: env.DURE_MEDIA_CLAUDE_BIN || "claude",
        args: [
          "--safe-mode",
          "--permission-mode",
          "plan",
          "--no-chrome",
          "--name",
          "dure-media-demo",
          ...optionalModelArgs(
            "--model",
            env.DURE_MEDIA_CLAUDE_MODEL || "haiku",
          ),
        ],
        prompt: PROVIDER_PROMPT,
      };
    case "kimi":
      return {
        executable: env.DURE_MEDIA_KIMI_BIN || "kimi",
        args: [
          "--plan",
          ...optionalModelArgs("--model", env.DURE_MEDIA_KIMI_MODEL),
        ],
        prompt: PROVIDER_PROMPT,
      };
    default:
      return null;
  }
}

export function liveProvidersForScenario(scenario) {
  return providersForScenario(scenario).filter(
    (provider) => providerSpec(provider) !== null,
  );
}

export function openedAgentsForScenario(scenario) {
  const openedAgentIds = new Set(
    [...scenario.setup, ...scenario.timeline]
      .filter(({ action }) => action === "openAgent")
      .map(({ agentId }) => agentId),
  );
  return scenario.fixture.agents.filter(({ id }) => openedAgentIds.has(id));
}

function headlessSpawnProviderTargets(scenario) {
  const target = scenario.fixture.headlessSpawn?.providerTarget;
  return target ? [target] : [];
}

function providerTargetsForScenario(scenario) {
  return [
    ...openedAgentsForScenario(scenario).map((agent) => ({
      agentId: agent.id,
      id: agent.sessionId,
      kind: agent.sessionKind,
      provider: agent.provider,
    })),
    ...(scenario.fixture.productTour?.providerTargets ?? []),
    ...headlessSpawnProviderTargets(scenario).map((target) => ({
      agentId: target.agentId,
      id: target.sessionId,
      kind: target.sessionKind,
      provider: target.provider,
    })),
  ].filter(
    (target, index, targets) =>
      targets.findIndex((candidate) => candidate.id === target.id) === index,
  );
}

export function providersForScenario(scenario) {
  return [
    ...new Set(providerTargetsForScenario(scenario).map(({ provider }) => provider)),
  ];
}

export function sessionTargetsForProvider(scenario, provider) {
  return providerTargetsForScenario(scenario)
    .filter((target) => target.provider === provider)
    .map(({ agentId, id, kind }) => ({ agentId, id, kind }));
}
