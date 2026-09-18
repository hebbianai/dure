import { evaluateJev, jevErrorReport, jevInputSchema } from "./jev.mjs";

export const jevMcpTool = {
  name: "jev_evaluate",
  description:
    "Evaluate explicit state against named TypeSafe Jev questions: noul (yes probability), choice (option), or score (zero-based rubric position). Batch independent questions sharing the same state. Returns probabilities, confidence, model, and usage; takes no action on the answers. Sends the supplied content to TypeSafe using TYPESAFE_API_KEY from this MCP server's environment, billed to that account. Requires no Dure app or backend; runs on this MCP server's host. Dure bounds requests to 512 KiB and API time to 15s, without retries.",
  inputSchema: jevInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

export async function callJevMcpTool(input, environment, dependencies = {}) {
  let receipt;
  try {
    receipt = await evaluateJev(input, { environment, fetchImpl: dependencies.jevFetch });
  } catch (error) {
    receipt = jevErrorReport(error);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(receipt) }],
    structuredContent: receipt,
    isError: Boolean(receipt.error),
  };
}
