// Test repositories are synthetic inputs, not developer-authored history.
// Keep every fixture Git command independent of global signing and credential
// configuration without mutating either the fixture or product repository.
const FIXTURE_GIT_CONFIG_ARGUMENTS = Object.freeze([
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "credential.helper=",
]);

export function fixtureGitArguments(...args) {
  return [...FIXTURE_GIT_CONFIG_ARGUMENTS, ...args];
}
