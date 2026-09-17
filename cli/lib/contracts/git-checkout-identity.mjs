export const GIT_CHECKOUT_INSTANCE_SCHEMA_VERSION_V1 = 1;
export const GIT_CHECKOUT_USE_MAX_PATH_BYTES_V1 = 8_192;

const INSTANCE_TOKEN = /^dwt1_[0-9a-f]{32}$/;
const encoder = new TextEncoder();

export function isAbsolutePosixGitPathV1(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("\0") &&
    value.split("/").every((component) => component !== "." && component !== "..") &&
    encoder.encode(value).byteLength <= GIT_CHECKOUT_USE_MAX_PATH_BYTES_V1
  );
}

export function isAbsoluteNativeGitPathV1(value) {
  return (
    isAbsolutePosixGitPathV1(value) ||
    (typeof value === "string" &&
      !value.includes("\0") &&
      value.split(/[\\/]/).every((component) => component !== "." && component !== "..") &&
      encoder.encode(value).byteLength <= GIT_CHECKOUT_USE_MAX_PATH_BYTES_V1 &&
      (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")))
  );
}

function normalizedPath(value) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function privateAdminBelongsToCommonDir(gitCommonDir, gitDir) {
  const common = normalizedPath(gitCommonDir);
  const privateDir = normalizedPath(gitDir);
  const separator = privateDir.lastIndexOf("/");
  return separator > 0 && privateDir.slice(0, separator) === `${common}/worktrees`;
}

export function isGitCheckoutInstanceV1(value, posixOnly = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const path = posixOnly ? isAbsolutePosixGitPathV1 : isAbsoluteNativeGitPathV1;
  return (
    Object.keys(value).length === 5 &&
    value.schemaVersion === GIT_CHECKOUT_INSTANCE_SCHEMA_VERSION_V1 &&
    path(value.canonicalPath) &&
    path(value.gitCommonDir) &&
    path(value.gitDir) &&
    value.gitDir !== value.gitCommonDir &&
    privateAdminBelongsToCommonDir(value.gitCommonDir, value.gitDir) &&
    typeof value.instanceToken === "string" &&
    INSTANCE_TOKEN.test(value.instanceToken)
  );
}

export function sameGitCheckoutInstanceV1(left, right) {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.gitCommonDir === right.gitCommonDir &&
    left.gitDir === right.gitDir &&
    left.instanceToken === right.instanceToken
  );
}
