import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { slackKey } from "./event.mjs";

export function writeSlackJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value));
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
}

/** Delivery metadata only. The backend remains the owner of tasks, runtime
 * bindings, conversation contents and turn state. Credentials never enter it. */
export class SlackJournal {
  constructor(file, config) {
    this.file = file;
    this.lock = `${file}.lock`;
    this.owner = randomUUID();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.teamId = config.teamId;
    this.identity = slackKey(config.teamId);
  }

  async acquire(resolveLegacyBackend) {
    // Never reclaim another process's lock implicitly. A stopped bridge leaves
    // its exact owner record for explicit recovery, without risking two writers.
    const descriptor = fs.openSync(this.lock, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, owner: this.owner }));
    fs.closeSync(descriptor);
    this.acquired = true;
    try {
      this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {
        schemaVersion: 2, identity: this.identity, inbox: {}, threads: {}, outbound: {},
      };
      if (this.data.schemaVersion === 1) {
        const { profileId, backendId } = await resolveLegacyBackend();
        // A current route cannot establish the historical data scope of an
        // older link. Preserve its known metadata without inventing that scope.
        const backend = { profileId, backendId };
        if (this.data.identity !== slackKey(this.teamId, backend.backendId)) {
          throw new Error("The legacy Slack journal requires its original workspace and backend.");
        }
        for (const thread of Object.values(this.data.threads)) thread.backend = backend;
        this.data = { ...this.data, schemaVersion: 2, identity: this.identity };
      }
      if (this.data.schemaVersion !== 2 || this.data.identity !== this.identity) {
        throw new Error("Slack delivery journal belongs to another workspace.");
      }
      this.save();
    } catch (error) { this.close(); throw error; }
  }

  save() {
    if (!this.acquired) throw new Error("Slack delivery journal is not owned by this process.");
    writeSlackJson(this.file, this.data);
  }

  accept(message, { operation, intent } = {}) {
    if (!message || this.data.inbox[message.key]) return false;
    const previous = this.data;
    const thread = previous.threads[message.threadKey] ?? {
      teamId: message.teamId, channelId: message.channelId, threadTs: message.threadTs,
      route: message.route, agentId: null, cursor: null, goalRevision: 0,
    };
    this.data = {
      ...previous,
      inbox: { ...previous.inbox, [message.key]: { message, state: message.contextOnly ? "context" : "queued", ...(intent ? { operation, intent } : {}) } },
      threads: { ...previous.threads, [message.threadKey]: thread },
    };
    try { this.save(); }
    catch (error) { this.data = previous; throw error; }
    return true;
  }

  close() {
    if (!this.acquired) return;
    const owner = JSON.parse(fs.readFileSync(this.lock, "utf8"));
    if (owner.owner !== this.owner) throw new Error("Slack journal ownership changed.");
    fs.unlinkSync(this.lock);
    this.acquired = false;
  }
}
