import { validProjectPath } from "../project-contract.mjs";
import {
  isAbsoluteNativeGitPathV1,
  isGitCheckoutInstanceV1,
  sameGitCheckoutInstanceV1,
} from "./git-checkout-identity.mjs";

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function onlyKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function onlyKeysWithOptional(value, keys, optional) {
  return value !== null && typeof value === "object" &&
    onlyKeys(value, [...keys, ...optional.filter((key) => key in value)]);
}

function validCheckoutReference(value) {
  return onlyKeys(value, ["canonicalPath", "gitCommonDir", "gitDir", "branch", "head"]) &&
    [value.canonicalPath, value.gitCommonDir, value.gitDir].every(isAbsoluteNativeGitPathV1) &&
    typeof value.branch === "string" && value.branch.length > 0 &&
    typeof value.head === "string" && GIT_OBJECT_ID.test(value.head);
}

export function selectedCheckoutReference(worktree) {
  return {
    canonicalPath: worktree.instance.canonicalPath,
    gitCommonDir: worktree.instance.gitCommonDir,
    gitDir: worktree.instance.gitDir,
    branch: worktree.branch,
    head: worktree.base_commit_sha,
  };
}

export function checkoutRegistrationMatches(worktree, registration) {
  return isGitCheckoutInstanceV1(registration?.instance) &&
    sameGitCheckoutInstanceV1(worktree.instance, registration.instance);
}

export function validWorktree(value, { allowUnresolvedBase = false } = {}) {
  if (onlyKeys(value, ["kind"]) && value.kind === "project_root") return true;
  if (value?.kind === "existing_checkout") {
    if (allowUnresolvedBase && onlyKeys(value, ["kind", "reference"])) return validCheckoutReference(value.reference);
    return onlyKeys(value, ["kind", "instance", "branch", "base_commit_sha"]) &&
      isGitCheckoutInstanceV1(value.instance) && validCheckoutReference(selectedCheckoutReference(value));
  }
  const keys = allowUnresolvedBase && value?.base_commit_sha === undefined
    ? ["kind", "branch"]
    : ["kind", "base_commit_sha", "branch"];
  return (
    onlyKeysWithOptional(value, keys, ["checkout_path", "branch_mode"]) &&
    value.kind === "dedicated" &&
    (value.branch_mode === undefined || value.branch_mode === "create" || value.branch_mode === "existing") &&
    (value.checkout_path === undefined || validProjectPath(value.checkout_path)) &&
    (allowUnresolvedBase && value.base_commit_sha === undefined
      ? true
      : GIT_OBJECT_ID.test(value.base_commit_sha)) &&
    typeof value.branch === "string" &&
    validBranch(value.branch)
  );
}

function validBranch(value) {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock") &&
    value !== "@" &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value.split("/").some(
      (component) =>
        component.length === 0 ||
        component.startsWith(".") ||
        component.endsWith(".lock"),
    ) &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint <= 0x1f ||
        codePoint === 0x7f ||
        " ~^:?*[\\".includes(character)
      );
    })
  );
}
