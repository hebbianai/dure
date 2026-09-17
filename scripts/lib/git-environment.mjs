// Git hooks export repository-local variables such as GIT_DIR. A child command
// that intentionally targets another cwd must not inherit those pointers.
// Keep transport/auth variables (for example GIT_ASKPASS) intact.
const LOCAL_GIT_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

export function withoutLocalGitOverrides(source = process.env) {
  const environment = { ...source };
  for (const variable of LOCAL_GIT_VARIABLES) {
    delete environment[variable];
  }
  return environment;
}
