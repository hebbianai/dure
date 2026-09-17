import {
  SSH_IMAGE_PASTE_PUBLIC_WEBM,
  SSH_IMAGE_PASTE_README_GIF,
} from "./ssh-image-paste-recipes.mjs";

const DEMO_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function createSshImagePasteScenario({ baseScenario }) {
  const fixture = structuredClone(baseScenario.fixture);
  fixture.activeDesktopId = "desk-launch";
  const remoteAgent = fixture.agents.find(
    ({ id }) => id === "agent-api-review",
  );
  remoteAgent.provider = "codex";
  remoteAgent.comment = "Reviewing an uploaded architecture screenshot";
  fixture.clipboardImagePaste = {
    schemaVersion: 1,
    agentId: "agent-api-review",
    sessionId: "session-kimi",
    image: {
      dataB64: DEMO_PNG_BASE64,
      ext: "png",
    },
    remotePath: "/tmp/dure-media-demo/architecture-overview.png",
  };
  return {
    ...baseScenario,
    id: "ssh-image-paste",
    title: "Image paste into an SSH agent",
    description:
      "A real clipboard image paste uploads through the SSH backend and inserts the remote path into a live Codex terminal.",
    durationMs: 7_000,
    stillAtMs: 5_200,
    readmeGif: SSH_IMAGE_PASTE_README_GIF,
    publicWebm: SSH_IMAGE_PASTE_PUBLIC_WEBM,
    fixture,
    setup: [
      {
        action: "openAgent",
        desktopId: "desk-launch",
        agentId: "agent-api-review",
        relativeToTerminal: true,
        direction: "right",
      },
    ],
    timeline: [
      {
        atMs: 3_200,
        action: "pasteClipboardImage",
        desktopId: "desk-launch",
        agentId: "agent-api-review",
      },
    ],
  };
}
