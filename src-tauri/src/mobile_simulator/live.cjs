// Dure owns this foreground worker; serve-sim supplies only the native addon.
// No device discovery, child processes, public control server, or global state.
const { readFileSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");

async function main() {
  const config = JSON.parse(readFileSync(0, "utf8"));
  if (Number(process.versions.node.split(".")[0]) < 20) throw Error("Live iOS requires Node.js 20 or newer");
  const addon = { exports: {} };
  process.dlopen(addon, config.addon);
  const { SimCapture, SimHID } = addon.exports;
  const capture = new SimCapture(config.device);
  const hid = new SimHID(config.device);
  let latest;
  let publishedAt = 0;
  let acting = false;
  let closing = false;
  const unsubscribe = await capture.subscribe(0, async (data, width, height) => {
    const now = Date.now();
    if (now - publishedAt < 50) return;
    publishedAt = now;
    if (data.length <= 8 * 1024 * 1024) latest = { dataUrl: `data:image/jpeg;base64,${Buffer.from(data).toString("base64")}`, width, height };
  });
  await capture.start();
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.headers.authorization !== `Bearer ${config.token}` || request.headers.origin) {
      response.writeHead(403).end(); return;
    }
    try {
      if (request.method === "GET" && request.url === "/frame") {
        if (!latest) { response.writeHead(204).end(); return; }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(latest)); return;
      }
      if (request.method === "POST" && request.url === "/close") {
        closing = true;
        while (acting) await delay(10);
        await unsubscribe(); await capture.stop();
        response.end("ok"); server.close(); return;
      }
      if (request.method !== "POST" || request.url !== "/action" || closing || acting) {
        response.writeHead(409).end("Worker is unavailable"); return;
      }
      acting = true;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 65536) throw Error("Input exceeds limit");
          chunks.push(chunk);
        }
        await input(hid, JSON.parse(Buffer.concat(chunks).toString("utf8")), latest);
        response.end("ok");
      } finally { acting = false; }
    } catch (error) { response.writeHead(400).end(String(error)); }
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  writeFileSync(config.ready, JSON.stringify({ port: server.address().port }), { mode: 0o600 });
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(0), 3000).unref();
    server.close();
    while (acting) await delay(10);
    await unsubscribe(); await capture.stop(); process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  // Reparenting is kernel evidence that this worker's original owner exited.
  // The worker exits itself; it never signals a possibly reused parent PID.
  const owner = process.ppid;
  if (owner === 1) await shutdown();
  setInterval(() => { if (process.ppid !== owner) void shutdown(); }, 500).unref();
}

async function input(hid, action, frame) {
  if (action.kind === "gesture") {
    if (!frame || action.width !== frame.width || action.height !== frame.height) throw Error("Device orientation changed; refresh before interacting");
    const { start, end, width, height } = action;
    if (![start.x, start.y, end.x, end.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) throw Error("Invalid touch coordinates");
    // The pinned native HID API takes normalized coordinates; w/h are ABI fields.
    const touch = (type, p) => hid.touch(type, p.x, p.y, width, height, 0);
    await touch("begin", start);
    try {
      if (Math.hypot(start.x - end.x, start.y - end.y) > 0.005) {
        for (let i = 1; i <= 10; i++) { await delay(25); await touch("move", { x: start.x + (end.x - start.x) * i / 10, y: start.y + (end.y - start.y) * i / 10 }); }
      } else await delay(30);
    } finally { await touch("end", end); }
  } else if (action.kind === "button" && action.button === "home") {
    await hid.button("home");
  } else if (action.kind === "rotate" && typeof action.landscape === "boolean") {
    if (!await hid.orientation(action.landscape ? 3 : 1)) throw Error("Simulator refused rotation");
  } else if (action.kind === "paste") {
    if (typeof action.text !== "string" || !action.text.length || Buffer.byteLength(action.text, "utf8") > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(action.text)) throw Error("Paste accepts 1–8192 UTF-8 bytes; only tab and line breaks are supported control characters");
    // The SDK adapter has populated only this simulator's pasteboard.
    try {
      await hid.key("down", 227);
      try { await hid.key("down", 25); } finally { await hid.key("up", 25); }
    } finally { await hid.key("up", 227); }
  } else if (action.kind === "type") {
    if (typeof action.text !== "string" || !action.text.length || action.text.length > 2048 || !/^[\x20-\x7e]+$/.test(action.text)) throw Error("Use printable ASCII text");
    for (const character of action.text) {
      const [usage, shift] = key(character);
      if (shift) await hid.key("down", 225);
      try { try { await hid.key("down", usage); } finally { await hid.key("up", usage); } }
      finally { if (shift) await hid.key("up", 225); }
    }
  } else throw Error("Unsupported live iOS input");
}

function key(character) {
  if (/[a-zA-Z]/.test(character)) return [character.toLowerCase().charCodeAt(0) - 97 + 4, character === character.toUpperCase()];
  const plain = "1234567890-=[]\\;'`,./ ";
  const shifted = "!@#$%^&*()_+{}|:\"~<>? ";
  const codes = [30,31,32,33,34,35,36,37,38,39,45,46,47,48,49,51,52,53,54,55,56,44];
  const index = plain.indexOf(character);
  if (index >= 0) return [codes[index], false];
  return [codes[shifted.indexOf(character)], true];
}

if (require.main === module) main().catch((error) => { console.error(String(error)); process.exit(1); });
module.exports = { input, key };
