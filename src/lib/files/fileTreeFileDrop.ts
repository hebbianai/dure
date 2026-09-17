import { describeExternalFileDropError } from "@/lib/files/externalFileDrop";

export function describeFileTreeFileDropError(
  error: unknown,
  t: (
    key: string,
    vars?: Record<string, string | number>,
  ) => string,
): string {
  const description = describeExternalFileDropError(error, t);
  const marker = "dropped_file_destination_exists:";
  const offset = description.indexOf(marker);
  if (offset >= 0) {
    const name = description.slice(offset + marker.length).trim();
    return t("files.transfer.duplicateName", {
      name: name || "-",
    });
  }
  return description;
}
