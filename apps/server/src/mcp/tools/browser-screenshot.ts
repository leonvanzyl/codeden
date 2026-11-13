import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, ToolOutput } from "../define";
import { postSharedArtifact } from "../transcript";

/** Largest screenshot also returned to the agent as an image (bigger ones: path only). */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

/**
 * `browser_screenshot` (§12.2): a PNG of the viewport, the full page or one element. It is
 * always saved as a `screenshot` artifact; `share: true` also shows it in the chat, and the
 * image is returned to the agent so it can see the page.
 */
export const browserScreenshot = defineTool({
  name: "browser_screenshot",
  description:
    "Take a PNG screenshot of your browser's page (viewport, `fullPage`, or one element by `ref`). It is saved as an artifact and returned to you as an image. Pass `share: true` to show it to the user in the chat (do this for screenshots that prove or illustrate your work).",
  roles: ["agent"],
  scope: "session",
  input: z.object({
    fullPage: z.boolean().optional(),
    ref: z
      .string()
      .regex(/^(f\d+)?e\d+$/)
      .optional()
      .describe("Element ref from browser_snapshot to capture just that element"),
    tabId: z.string().min(1).max(100).optional(),
    share: z.boolean().optional().describe("Also show the screenshot in the chat"),
    caption: z.string().max(1_000).optional().describe("Caption shown with a shared screenshot"),
    returnImage: z
      .boolean()
      .optional()
      .describe("Return the image to you (default true); false returns only the file path"),
  }),
  handler: async (input, { services, sessionId }) => {
    const session = services.sessionRepo.get(sessionId);
    const incoming = join(services.paths.artifacts, ".incoming");
    mkdirSync(incoming, { recursive: true });
    const tmp = join(incoming, `${randomUUID()}.png`);
    try {
      const shot = await services.browser.agentCommand({
        name: "browser.screenshot",
        sessionId,
        path: tmp,
        fullPage: input.fullPage,
        ref: input.ref,
        tabId: input.tabId,
      });
      const bytes = readFileSync(tmp);
      const artifact = services.artifacts.save({
        bytes,
        name: `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
        mediaType: "image/png",
        kind: "screenshot",
        projectId: session.projectId,
        sessionId,
      });
      if (input.share) postSharedArtifact(services, sessionId, artifact, input.caption);
      const file = services.artifacts.filePath(artifact);
      const viewport = !input.fullPage && !input.ref;
      const text = [
        `Screenshot ${shot.width}x${shot.height} saved as artifact ${artifact.id}${input.share ? " and shared in the chat" : ""}.`,
        `File: ${file}`,
        ...(viewport
          ? [
              `Viewport ${shot.width}x${shot.height} CSS pixels: use these image coordinates with browser_mouse.`,
            ]
          : []),
      ].join("\n");
      const inline = input.returnImage !== false && bytes.length <= MAX_INLINE_BYTES;
      return new ToolOutput(
        text,
        inline ? [{ data: bytes.toString("base64"), mediaType: "image/png" }] : [],
      );
    } finally {
      rmSync(tmp, { force: true });
    }
  },
});
