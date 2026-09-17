/** Remove repository-local routing overrides from a child Git environment. */
export function withoutLocalGitOverrides(
  source?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
