const PROJECT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function validProjectId(value) {
  return typeof value === "string" && PROJECT_ID.test(value);
}

export function validProjectPath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    Buffer.byteLength(value, "utf8") <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
