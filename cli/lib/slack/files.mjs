import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slackKey } from "./event.mjs";
import { buildPromptWithAttachments } from "../contracts/prompt-attachments.mjs";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 10;
const SCOPE_HINT = "Ask a workspace admin to add files:read and files:write to the Dure Slack app and reinstall it.";

function unavailable(error) {
  return error?.code === "slack_missing_scope" ? SCOPE_HINT : "File contents are unavailable. Open the task in Dure to access the file.";
}

function localPath(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("file:")) return fileURLToPath(decoded);
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(decoded) && !path.win32.isAbsolute(decoded)) return null;
    if (/^(?:#|\/\/)/.test(decoded)) return null;
    return decoded;
  } catch { return null; }
}

/** Parse links outside code without turning local paths into Slack-relative URLs. */
export function localFileLinks(markdown) {
  const links = [];
  const pattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|!?\[([^\]\n]+)\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/g;
  for (const match of markdown.matchAll(pattern)) {
    if (match[1]) continue;
    const filename = localPath(match[3].replace(/^<|>$/g, ""));
    if (filename) links.push({ offset: match.index, raw: match[0], label: match[2], filename });
  }
  return links;
}

/** File transport state belongs to the connector journal; task paths and scope
 * still come from the backend. No remote path is opened on this machine. */
export class SlackFiles {
  constructor({ journal, backend, slack }) {
    Object.assign(this, { journal, backend, slack });
  }

  async prepareInput(message, thread) {
    const location = await this.backend.localFiles(thread).catch(() => null);
    const lines = [];
    const images = [];
    let total = 0;
    for (const [index, file] of message.files.entries()) {
      try {
        if (!location || index >= MAX_FILES) throw new Error("Attachment transport unavailable");
        const { bytes, mimetype } = await this.slack.downloadFile(file.id, MAX_FILE_BYTES - total);
        total += bytes.length;
        const directory = `${this.journal.file}.files`;
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const directoryStat = await fs.lstat(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Attachment directory unavailable");
        const extension = path.extname(file.name).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12);
        const filename = path.join(directory, `${slackKey(message.key, file.id)}${extension}`);
        // A restarted unsubmitted input may reuse the same file, but never
        // follows a symlink placed at that destination.
        const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(bytes); } finally { await handle.close(); }
        if (mimetype?.startsWith("image/")) images.push(filename);
        else lines.push(`Read the attached file ${index + 1} before starting: ${filename}`);
      } catch (error) {
        lines.push(`Slack attachment: ${file.name} (${file.id}). ${unavailable(error)}`);
      }
    }
    return buildPromptWithAttachments(lines.join("\n"), images);
  }

  async publish(thread, itemId, markdown) {
    const links = localFileLinks(markdown);
    if (!links.length) return markdown;
    const location = await this.backend.localFiles(thread).catch(() => null);
    let root;
    if (location?.root) root = await fs.realpath(location.root).catch(() => null);
    let result = "";
    let offset = 0;
    let count = 0;
    let total = 0;
    const notices = new Set();
    for (const link of links) {
      result += markdown.slice(offset, link.offset);
      offset = link.offset + link.raw.length;
      const key = slackKey(thread.teamId, thread.channelId, thread.threadTs, itemId, link.filename);
      this.journal.data.files ??= {};
      let receipt = this.journal.data.files[key];
      if (!receipt) {
        let handle;
        try {
          if (!root || count++ >= MAX_FILES) throw new Error("Task files unavailable");
          const selected = await fs.realpath(path.resolve(root, link.filename));
          const relative = path.relative(root, selected);
          if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) ||
              relative.split(path.sep).some((part) => part === ".git")) throw new Error("File is outside the task workspace");
          handle = await fs.open(selected, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES - total) throw new Error("File is unavailable or too large");
          total += stat.size;
          const bytes = Buffer.alloc(stat.size);
          let received = 0;
          while (received < bytes.length) {
            const part = await handle.read(bytes, received, bytes.length - received, received);
            if (!part.bytesRead) throw new Error("File changed during upload");
            received += part.bytesRead;
          }
          const after = await handle.stat();
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("File changed during upload");
          receipt = this.journal.data.files[key] = { state: "sending" };
          this.journal.save();
          const uploaded = await this.slack.uploadFile(thread, { name: path.basename(selected), bytes }, (id) => {
            receipt.id = id;
            this.journal.save();
          });
          Object.assign(receipt, uploaded, { state: "shared" });
          this.journal.save();
        } catch (error) {
          const notice = receipt?.id ? "File delivery could not be confirmed and has not been retried." : unavailable(error);
          receipt = this.journal.data.files[key] = { ...receipt, state: "failed", notice };
          this.journal.save();
        } finally { await handle?.close(); }
      }
      if (receipt.state === "shared") result += `[${link.label}](${receipt.permalink})`;
      else {
        result += `${link.label} (file unavailable in Slack)`;
        notices.add(receipt.notice ?? "File delivery could not be confirmed and has not been retried.");
      }
    }
    result += markdown.slice(offset);
    return notices.size ? `${result}\n\n${[...notices].join("\n")}` : result;
  }
}
