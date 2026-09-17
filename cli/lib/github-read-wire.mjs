export const GITHUB_READ_VERSION = "dure.github.read/v1";
export const GITHUB_READ_REQUEST_BYTES = 32 * 1024;
export const GITHUB_READ_RESPONSE_BYTES = 6 * 1024 * 1024;
export const GITHUB_READ_CONCURRENCY = 4;

export async function* githubReadFrames(stream, maximum) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      if (end === 0 || end > maximum) throw new Error("Invalid GitHub bridge frame size.");
      const frame = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, end));
      pending = pending.subarray(end + 1);
      yield JSON.parse(frame);
    }
    if (pending.length > maximum) throw new Error("GitHub bridge frame exceeds its limit.");
  }
  if (pending.length) throw new Error("GitHub bridge response was interrupted.");
}

export function writeGithubReadFrame(stream, frame, maximum) {
  const data = Buffer.from(`${JSON.stringify(frame)}\n`);
  if (data.length > maximum + 1)
    return Promise.reject(new Error("GitHub bridge frame exceeds its limit."));
  return new Promise((resolve, reject) =>
    stream.write(data, (error) => (error ? reject(error) : resolve())),
  );
}

export function githubReadResult(value) {
  return (
    value?.version === GITHUB_READ_VERSION &&
    Number.isInteger(value.code) &&
    value.code >= 0 &&
    value.code <= 255 &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string"
  );
}
