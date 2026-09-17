export const GIT_CHECKOUT_INSTANCE_SCHEMA_VERSION_V1: 1;
export const GIT_CHECKOUT_USE_MAX_PATH_BYTES_V1: 8192;

/** Provider-neutral identity for one exact linked Git checkout generation. */
export interface GitCheckoutInstanceV1 {
  readonly schemaVersion: typeof GIT_CHECKOUT_INSTANCE_SCHEMA_VERSION_V1;
  readonly canonicalPath: string;
  readonly gitCommonDir: string;
  readonly gitDir: string;
  readonly instanceToken: string;
}

export function isAbsolutePosixGitPathV1(value: unknown): value is string;
export function isAbsoluteNativeGitPathV1(value: unknown): value is string;
export function isGitCheckoutInstanceV1(
  value: unknown,
  posixOnly?: boolean,
): value is GitCheckoutInstanceV1;
export function sameGitCheckoutInstanceV1(
  left: GitCheckoutInstanceV1,
  right: GitCheckoutInstanceV1,
): boolean;
