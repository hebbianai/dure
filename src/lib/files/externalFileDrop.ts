import { bytesToBase64 } from "@/lib/platform/base64";

export const MAX_EXTERNAL_DROP_FILES = 5;
export const MAX_EXTERNAL_DROP_BYTES = 50 * 1024 * 1024;

export type ExternalFileDropErrorCode =
  | "too_many_files"
  | "file_too_large"
  | "total_too_large"
  | "invalid_file"
  | "invalid_backend_result";

export class ExternalFileDropError extends Error {
  constructor(
    readonly code: ExternalFileDropErrorCode,
    readonly fileName?: string,
  ) {
    super(code);
    this.name = "ExternalFileDropError";
  }
}

export interface DroppedFileLike {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DroppedFilePayload {
  fileName: string;
  dataB64: string;
}

function validateDroppedFiles(files: readonly DroppedFileLike[]): void {
  if (files.length === 0) throw new ExternalFileDropError("invalid_file");
  if (files.length > MAX_EXTERNAL_DROP_FILES) {
    throw new ExternalFileDropError("too_many_files");
  }

  let totalBytes = 0;
  for (const file of files) {
    if (!file.name || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new ExternalFileDropError("invalid_file", file.name);
    }
    if (file.size > MAX_EXTERNAL_DROP_BYTES) {
      throw new ExternalFileDropError("file_too_large", file.name);
    }
    totalBytes += file.size;
    if (totalBytes > MAX_EXTERNAL_DROP_BYTES) {
      throw new ExternalFileDropError("total_too_large");
    }
  }
}

export async function prepareDroppedFilePayloads(
  filesLike: ArrayLike<DroppedFileLike>,
): Promise<DroppedFilePayload[]> {
  const files = Array.from(filesLike);
  validateDroppedFiles(files);
  const payloads: DroppedFilePayload[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_EXTERNAL_DROP_BYTES) {
      throw new ExternalFileDropError("file_too_large", file.name);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_EXTERNAL_DROP_BYTES) {
      throw new ExternalFileDropError("total_too_large");
    }
    payloads.push({ fileName: file.name, dataB64: bytesToBase64(bytes) });
  }

  return payloads;
}

export function isExternalFileDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"));
}

export function describeExternalFileDropError(
  error: unknown,
  t: (
    key: string,
    vars?: Record<string, string | number>,
  ) => string,
): string {
  if (!(error instanceof ExternalFileDropError)) return String(error);
  switch (error.code) {
    case "too_many_files":
      return t("files.transfer.tooManyFiles");
    case "file_too_large":
      return t("files.transfer.fileTooLarge", {
        name: error.fileName || "-",
      });
    case "total_too_large":
      return t("files.transfer.totalTooLarge");
    case "invalid_file":
      return t("files.transfer.infoUnreadable");
    case "invalid_backend_result":
      return t("files.transfer.prepareInvalid");
  }
}

/** Paths returned by local saves and remote uploads must remain literal file
 * references when pasted into a terminal or appended to an agent prompt. */
export function preparedFilePaths(value: unknown, count: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    !value.every(
      (path) =>
        typeof path === "string" &&
        path.startsWith("/") &&
        path.length <= 4096 &&
        Array.from(path).every(
          (character) =>
            character.charCodeAt(0) > 0x1f && character.charCodeAt(0) !== 0x7f,
        ),
    )
  )
    throw new ExternalFileDropError("invalid_backend_result");
  return value;
}
