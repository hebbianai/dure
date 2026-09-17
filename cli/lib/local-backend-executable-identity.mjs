import { isAbsolute } from "node:path";

export const LOCAL_EXECUTABLE_IDENTITY_KEYS = Object.freeze([
  "executablePath",
  "executableDevice",
  "executableInode",
  "executableSize",
  "executableModified",
  "executableSha256",
]);

const DECIMAL_IDENTITY = /^[0-9]{1,64}$/;
const MODIFIED_IDENTITY = /^[0-9]{1,32}:[0-9]{1,32}$/;
const SHA256_IDENTITY = /^[a-f0-9]{64}$/;

export function parseLocalExecutableIdentity(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== LOCAL_EXECUTABLE_IDENTITY_KEYS.length ||
    !LOCAL_EXECUTABLE_IDENTITY_KEYS.every((key) => Object.hasOwn(value, key)) ||
    typeof value.executablePath !== "string" ||
    value.executablePath.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(value.executablePath) ||
    !isAbsolute(value.executablePath) ||
    typeof value.executableDevice !== "string" ||
    !DECIMAL_IDENTITY.test(value.executableDevice) ||
    typeof value.executableInode !== "string" ||
    !DECIMAL_IDENTITY.test(value.executableInode) ||
    typeof value.executableSize !== "string" ||
    !DECIMAL_IDENTITY.test(value.executableSize) ||
    typeof value.executableModified !== "string" ||
    !MODIFIED_IDENTITY.test(value.executableModified) ||
    typeof value.executableSha256 !== "string" ||
    !SHA256_IDENTITY.test(value.executableSha256)
  ) {
    return null;
  }
  return Object.fromEntries(
    LOCAL_EXECUTABLE_IDENTITY_KEYS.map((key) => [key, value[key]]),
  );
}
