const REPOSITORY =
  /^(?:([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)$/;
const LIST_FLAGS = new Map([
  ["--assignee", "--assignee"],
  ["-a", "--assignee"],
  ["--author", "--author"],
  ["-A", "--author"],
  ["--label", "--label"],
  ["-l", "--label"],
  ["--limit", "--limit"],
  ["-L", "--limit"],
  ["--mention", "--mention"],
  ["--milestone", "--milestone"],
  ["-m", "--milestone"],
  ["--search", "--search"],
  ["-S", "--search"],
  ["--state", "--state"],
  ["-s", "--state"],
  ["--json", "--json"],
]);

export class GithubReadError extends Error {
  constructor(message) {
    super(message);
    this.name = "GithubReadError";
  }
}

export function githubReadRepository(value) {
  const match = typeof value === "string" && value.length <= 256 && REPOSITORY.exec(value);
  if (!match || match[3] === "." || match[3] === ".." || match[1]?.includes("..")) {
    throw new GithubReadError("Use a repository in [HOST/]OWNER/REPO form.");
  }
  return `${match[1] || "github.com"}/${match[2]}/${match[3]}`.toLowerCase();
}

/** Rebuild argv at the local authority; never forward arbitrary gh commands. */
export function githubReadArguments(input, repository) {
  const pinned = githubReadRepository(repository);
  if (
    !Array.isArray(input) ||
    input.length > 64 ||
    input.some(
      (value) =>
        typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value),
    )
  )
    throw new GithubReadError("Invalid GitHub read arguments.");
  const args = [];
  for (let i = 0; i < input.length; i += 1) {
    const token = input[i];
    const repoFlag = token === "--repo" || token === "-R";
    if (repoFlag || token.startsWith("--repo=") || (token.startsWith("-R") && token.length > 2)) {
      const value = repoFlag
        ? input[++i]
        : token.startsWith("--repo=")
          ? token.slice(7)
          : token.slice(2);
      if (githubReadRepository(value) !== pinned)
        throw new GithubReadError("This share only permits its selected repository.");
    } else args.push(token);
  }
  const [command, operation, ...options] = args;
  if (command !== "issue" || !["list", "view"].includes(operation)) {
    throw new GithubReadError("This share supports gh issue list and gh issue view only.");
  }
  const result = ["issue", operation, "--repo", pinned];
  let issue;
  for (let i = 0; i < options.length; i += 1) {
    const token = options[i];
    if (operation === "view" && !token.startsWith("-")) {
      if (issue !== undefined) throw new GithubReadError("Specify one issue number.");
      let number = token;
      if (token.startsWith("https://")) {
        const match = /^https:\/\/([^/]+\/[^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/.exec(token);
        if (!match || githubReadRepository(match[1]) !== pinned)
          throw new GithubReadError("The issue URL is outside the shared repository.");
        number = match[2];
      }
      if (!/^[1-9][0-9]{0,14}$/.test(number))
        throw new GithubReadError("Specify a positive issue number.");
      issue = number;
      result.push(number);
      continue;
    }
    if (operation === "view" && ["--comments", "-c"].includes(token)) {
      result.push("--comments");
      continue;
    }
    const equal = token.indexOf("=");
    const key = equal < 0 ? token : token.slice(0, equal);
    const flag = operation === "list" ? LIST_FLAGS.get(key) : key === "--json" ? key : undefined;
    if (!flag) throw new GithubReadError(`Unsupported read option: ${key}`);
    const value = equal < 0 ? options[++i] : token.slice(equal + 1);
    if (value === undefined || value === "") throw new GithubReadError(`${key} requires a value.`);
    if (flag === "--limit" && (!/^[1-9][0-9]*$/.test(value) || Number(value) > 1000))
      throw new GithubReadError("The issue limit must be between 1 and 1000.");
    if (flag === "--state" && !["open", "closed", "all"].includes(value))
      throw new GithubReadError("Invalid issue state.");
    if (flag === "--json" && !/^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/.test(value))
      throw new GithubReadError("Specify comma-separated JSON field names.");
    // Search uses GitHub's query language; extra repository/OR clauses can widen its scope.
    if (flag === "--search" && /(?:^|[\s(])[+-]?(?:repo|org|user):|\bOR\b/i.test(value))
      throw new GithubReadError("Search cannot override the shared repository or use OR.");
    result.push(flag, value);
  }
  if (operation === "view" && issue === undefined)
    throw new GithubReadError("Specify an issue number.");
  return result;
}
