import { z } from "zod";
import { defineTool } from "../../define";
import { inGithubProject } from "./available";

/** `attach_evidence` (§8.3, §9): screenshots, files and test output on the PR or issue. */
export const attachEvidenceTool = defineTool({
  name: "attach_evidence",
  description:
    "Attach evidence to your pull request or an issue: screenshots and files are committed to the repository's `codeden/evidence` branch and embedded in one comment (images render inline), with an optional Markdown summary and raw test output in a collapsed block. This is how images reach GitHub: its API (and so `gh`) can't upload them. Files are paths in your worktree or the temp folder, the `File:` path browser_screenshot prints, or artifact ids. Defaults to your session's PR, then its issue; pass `target` for any other issue or PR. The result lists each file's URL, which you can reuse in an issue or PR description.",
  roles: ["agent"],
  scope: "session",
  isAvailable: inGithubProject,
  alwaysLoad: true,
  input: z
    .object({
      target: z
        .object({ kind: z.enum(["pr", "issue"]), number: z.int().positive() })
        .optional()
        .describe("Default: your PR, else your issue"),
      files: z
        .array(
          z
            .object({
              path: z.string().min(1).optional().describe("Absolute, or relative to your worktree"),
              artifactId: z.string().min(1).optional(),
              name: z.string().min(1).max(100).optional(),
              caption: z.string().max(500).optional(),
            })
            .refine((f) => (f.path === undefined) !== (f.artifactId === undefined), {
              message: "Pass exactly one of path or artifactId",
            }),
        )
        .max(10)
        .optional(),
      summary: z
        .string()
        .max(20_000)
        .optional()
        .describe("Markdown: what you verified and how, e.g. a test results summary"),
      testOutput: z
        .string()
        .max(500_000)
        .optional()
        .describe("Raw test output; long output keeps its tail"),
    })
    .refine((v) => (v.files?.length ?? 0) > 0 || v.summary || v.testOutput, {
      message: "Pass files, a summary or testOutput",
    }),
  handler: async (input, { services, sessionId }) => {
    const result = await services.github.attachEvidence(sessionId, input);
    const files = result.files.map((f) => `- ${f.name}: ${f.url}`).join("\n");
    return `Posted evidence on ${result.target.kind === "pr" ? "PR" : "issue"} #${result.target.number}: ${result.commentUrl}${files ? `\n${files}` : ""}`;
  },
});
