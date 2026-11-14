import { MAX_UPLOAD_FILES } from "@codeden/contracts";
import { z } from "zod";
import { localOutgoingFile, remoteOutgoingFile } from "../../services/outgoing-paths";
import { remoteWorkspaceFs } from "../../services/workspace-fs/workspace-fs";
import { defineTool } from "../define";
import { ref, tabId } from "./browser";
import { withDialogNote } from "./browser-dialog";

/**
 * `browser_upload` (§12.2, computer use step 2): set files on a file input, or answer the file
 * chooser a button or drop zone opens. A page can send what it is given anywhere, so the files
 * follow the rule for every file that leaves CodeDen (`../../services/outgoing-paths`): only
 * from the session's own folders, never a secrets file. The runner gets the checked real paths.
 */

/** A path's file name, whichever machine's separators it uses. */
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export const browserUpload = defineTool({
  name: "browser_upload",
  description: `Upload files in your browser. Pass the ref of a file input (browser_snapshot shows one as a button, e.g. button "Choose file"), or of the button or drop zone whose click opens a file chooser, plus the files. CodeDen sets the files on the input, or clicks and answers the file chooser that opens, and the page gets its change event. Don't click upload buttons with browser_click: nothing answers the file chooser that opens then. Paths are absolute or relative to your working directory, and must be inside it, the temp folder or your own CodeDen artifacts (such as the File: path browser_screenshot prints); on a sandboxed runner, inside your working directory only. Secrets files (.env, keys, credentials) are refused. At most ${MAX_UPLOAD_FILES} files, and several only where the input takes multiple files.`,
  roles: ["agent"],
  scope: "session",
  input: z.object({
    ref: ref.describe(
      "Ref of the file input, or of the button or drop zone that opens a file chooser",
    ),
    paths: z
      .array(z.string().min(1).max(4_096))
      .min(1)
      .max(MAX_UPLOAD_FILES)
      .describe("Files to upload: absolute, or relative to your working directory"),
    tabId,
  }),
  handler: async (input, { services, sessionId }) => {
    const session = services.sessionRepo.get(sessionId);
    const home = services.paths.home;
    // A workspace on another runner's disk is checked through that runner, never this disk.
    const remote = remoteWorkspaceFs(services, session);
    const paths: string[] = [];
    for (const path of input.paths) {
      paths.push(
        remote
          ? await remoteOutgoingFile(remote, path, { home, use: "uploaded" })
          : localOutgoingFile(path, {
              cwd: session.cwd,
              artifactsDir: services.artifacts.sessionDir(session.id),
              home,
              use: "uploaded",
            }),
      );
    }
    const { dialog, via } = await services.browser.agentCommand({
      name: "browser.upload",
      sessionId,
      ref: input.ref,
      paths,
      tabId: input.tabId,
    });
    const files = `${paths.length} file${paths.length === 1 ? "" : "s"} (${paths.map(fileName).join(", ")})`;
    const text =
      via === "input"
        ? `Set ${files} on ${input.ref}.`
        : via === "chooser"
          ? `Clicked ${input.ref} and chose ${files} in the file chooser it opened.`
          : `Clicked ${input.ref} to upload ${files}.`;
    return withDialogNote(text, dialog);
  },
});
