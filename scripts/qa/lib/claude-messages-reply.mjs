/** Answer one Messages API request the way the provider streams it: a
 * message of `content` blocks (text, or tool_use with its input), ending
 * with `stopReason`. For QA fixtures that stand in for the provider's API
 * behind a real Claude Code. */
export function replyClaudeMessage(response, model, content, stopReason) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  for (const [index, block] of content.entries()) {
    send("content_block_start", { index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
    send("content_block_delta", { index, delta: block.type === "text" ? { type: "text_delta", text: block.text }
      : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    send("content_block_stop", { index });
  }
  send("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 12 } });
  send("message_stop", {});
  response.end();
}
