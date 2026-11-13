import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES } from "../../services/artifacts";
import { realPathOf } from "../../services/files/path-guard";
import { assertNotSecret } from "../../services/secret-files";
import { defineTool, ToolError } from "../define";
import { postSharedArtifact } from "../transcript";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".log": "text/plain",
  ".html": "text/html",
  ".pdf": "application/pdf",
};

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `share_to_chat` (§8.3, §12.2): a file or image, stored as an artifact and shown inline. */
export const shareToChat = defineTool({
  name: "share_to_chat",
  description:
    "Show the user a file or image in the chat: a screenshot, a generated image, a chart, a log. Pass `path` (absolute, or relative to your working directory) or `imageBase64` with `mediaType`. Use it for every screenshot or image you want the user to see.",
  roles: ["agent", "pm", "orchestrator"],
  scope: "session",
  alwaysLoad: true,
  input: z
    .object({
      path: z.string().min(1).optional(),
      imageBase64: z.string().min(1).optional(),
      mediaType: z.string().optional().describe("e.g. image/png; needed with imageBase64"),
      name: z.string().max(200).optional(),
      caption: z.string().max(1_000).optional(),
    })
    .refine((v) => (v.path === undefined) !== (v.imageBase64 === undefined), {
      message: "Pass exactly one of path or imageBase64",
    }),
  handler: async (input, { services, sessionId }) => {
    const session = services.sessionRepo.get(sessionId);
    let bytes: Buffer;
    let name: string;
    let mediaType: string;
    if (input.path) {
      const absolute = resolve(session.cwd, input.path);
      // Checks and the read use the real file (links, junctions and short names resolved).
      const real = existsSync(absolute) && statSync(absolute).isFile() && realPathOf(absolute);
      if (!real) throw new ToolError(`File not found: ${input.path}`);
      const roots = [session.cwd, tmpdir(), services.artifacts.sessionDir(session.id)].flatMap(
        (p) => realPathOf(p) ?? [],
      );
      if (!roots.some((root) => isInside(root, real))) {
        throw new ToolError(
          "Only files inside your working directory, the temp folder or your own CodeDen artifacts can be shared",
        );
      }
      name = input.name ?? basename(real);
      // Artifacts can be published with attach_evidence, so secrets never become one.
      const stored = services.artifacts.artifactForFile(real)?.name;
      assertNotSecret(
        { realPath: real, paths: [input.path], names: [stored, name] },
        services.paths.home,
      );
      if (statSync(real).size > MAX_ATTACHMENT_BYTES)
        throw new ToolError("File is larger than 20 MB");
      bytes = readFileSync(real);
      mediaType =
        input.mediaType ?? MEDIA_TYPES[extname(real).toLowerCase()] ?? "application/octet-stream";
    } else {
      bytes = Buffer.from(input.imageBase64 ?? "", "base64");
      if (bytes.length === 0) throw new ToolError("imageBase64 is empty or not base64");
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw new ToolError("Image is larger than 20 MB");
      mediaType = input.mediaType ?? "image/png";
      name = input.name ?? `image${extensionFor(mediaType)}`;
      assertNotSecret({ names: [name] }, services.paths.home);
    }
    const isImage = mediaType.startsWith("image/");
    const artifact = services.artifacts.save({
      bytes,
      name,
      mediaType,
      kind: isImage ? "image" : "file",
      projectId: session.projectId,
      sessionId,
    });
    postSharedArtifact(services, sessionId, artifact, input.caption);
    return `Shared ${name} in the chat (artifact ${artifact.id}).`;
  },
});

function extensionFor(mediaType: string): string {
  return Object.entries(MEDIA_TYPES).find(([, type]) => type === mediaType)?.[0] ?? ".bin";
}
