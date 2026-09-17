export function providerProvenance(providerMedia) {
  const liveProviders = [...providerMedia.providers];
  const fallbackProviders = [...providerMedia.fallbackProviders];
  const providerSources = Object.fromEntries([
    ...liveProviders.map((provider) => [provider, "live"]),
    ...fallbackProviders.map((provider) => [provider, "fixture"]),
  ]);
  const effectiveProviderSource =
    liveProviders.length === 0
      ? "fixture"
      : fallbackProviders.length === 0
        ? "live"
        : "mixed";
  return {
    effectiveProviderSource,
    providerSources,
    liveProviders,
    fallbackProviders,
    fallbackReasons: { ...providerMedia.fallbackReasons },
  };
}
