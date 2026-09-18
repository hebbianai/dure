import { readUtf8Input } from "./text-input.mjs";
import { evaluateJev, JevError, JEV_REQUEST_BYTES, jevErrorReport } from "./jev.mjs";

export const JEV_HELP = `dure jev — evaluate typed questions with TypeSafe Jev

Usage:
  dure jev evaluate <request.json|-> [--json]

Read JSON from a file, or from stdin with -. Set TYPESAFE_API_KEY in this
process's environment. Requests go directly to https://api.typesafe.ai/v1/systemone
from the machine running this command; no running Dure app is required.

Example request:
  {"state":"The app crashes on launch.","questions":{"bug":{"type":"noul","instructions":"Does this report a bug?"}}}

model defaults to jev-latest. Each named question needs type and instructions:
  noul:   optional criteria {"true":"yes description","false":"no description"}
  choice: criteria {"option":"description",...}, with 2–255 options (null allowed)
  score:  criteria ["lowest level",...,"highest level"], with 2–10 levels

state and instructions accept text, objects, or arrays. Results are JSON with
the model, answers, probability distributions, confidence, and token usage.
Noul is a probability from 0 to 1; Score uses zero-based rubric positions.
--json also writes failures as JSON to stdout. Exit 0 means success; 2 means failure.

Dure limits request input to 512 KiB, responses to 2 MiB, and API time to 15s.
TypeSafe's token budget also applies. No automatic retries or actions are taken.
Only the supplied state and questions are sent; use non-sensitive test content
for a first call. API usage is billed by TypeSafe.
`;

export async function runJevCommand(
  args,
  { environment = process.env, fetchImpl, stdout = process.stdout, stderr = process.stderr } = {},
) {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]))) {
    stdout.write(JEV_HELP);
    return 0;
  }
  const json = args.includes("--json");
  try {
    const [action, source, ...flags] = args;
    if (
      action !== "evaluate" ||
      !source ||
      (source.startsWith("-") && source !== "-") ||
      flags.length > 1 ||
      (flags.length === 1 && flags[0] !== "--json")
    ) {
      throw new JevError("jev_usage", "Usage: dure jev evaluate <request.json|-> [--json]");
    }
    let input;
    try {
      input = JSON.parse(readUtf8Input(source === "-" ? 0 : source, JEV_REQUEST_BYTES));
    } catch {
      throw new JevError(
        "jev_input_invalid",
        "Read a JSON request from an accessible file or stdin, at most 512 KiB.",
      );
    }
    const result = await evaluateJev(input, { environment, fetchImpl });
    stdout.write(`${JSON.stringify(result, null, json ? undefined : 2)}\n`);
    return 0;
  } catch (error) {
    const report = jevErrorReport(error);
    if (json) stdout.write(`${JSON.stringify(report)}\n`);
    else stderr.write(`${report.error.message}\n`);
    return 2;
  }
}
