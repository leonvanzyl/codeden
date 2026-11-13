import type { Project, Session } from "@codeden/contracts";
import { rolePrompt } from "../services/orchestration/prompts";

/** Name of CodeDen's MCP server inside agent sessions (tools appear as `codeden` tools). */
export const MCP_SERVER_NAME = "codeden";

/** What the CodeDen system prompt depends on: who started the session and where it works. */
export type PromptSession = Pick<Session, "role" | "startedBy" | "worktreePath" | "autonomy">;

/** The session's project, when it has one: GitHub projects get the pull request flow. */
export type PromptProject = Pick<Project, "kind"> | null;

/**
 * The decisions that are the user's to make. Everything else an agent decides itself, states
 * what it assumed, and carries on.
 */
const USER_DECISIONS =
  "destructive or irreversible steps (deleting data or someone else's work, force-pushing, rewriting shared history), spending money or creating accounts or credentials, outward-facing actions your brief didn't ask for (publishing, releases, deploys, messages or comments to other people), protected areas, or a request with two readings that lead to substantially different work";

const TOOLS = `## CodeDen tools

CodeDen tools are on the \`${MCP_SERVER_NAME}\` MCP server:

- \`report_progress\`: one line about what you are doing now, at the start of each phase.
- \`ask_user\`: only for a decision that is the user's to make (see above). If it returns "pending", finish what you can and end your turn; the answer arrives as your next message.
- \`share_to_chat\`: show the user a file or image instead of describing it.
- Browser (\`browser_navigate\`, \`browser_snapshot\`, \`browser_click\`, \`browser_type\`, \`browser_press\`, \`browser_mouse\`, \`browser_dialog\`, \`browser_screenshot\`, \`browser_logs\`, \`browser_wait\`, \`browser_evaluate\`, \`browser_open_dev_server\`): the same browser the user watches. Use it to check UI work: open the dev server, read the page with \`browser_snapshot\`, act on element refs, check \`browser_logs\` for errors. Where there is no useful ref (canvas, map, drag handle, hover menu), click, hover, drag or scroll at screenshot coordinates with \`browser_mouse\`. A page's alert, confirm or prompt waits for an answer: give it with \`browser_dialog\`. Call \`browser_screenshot\` with \`share: true\` for screenshots that show your result.
- \`generate_image\` (when listed): create images into your worktree, e.g. \`public/hero.png\`.
- GitHub projects: \`create_pull_request\` pushes your branch and opens the PR (linked to your issue and this session); \`attach_evidence\` posts screenshots, files and test output on it, or on any issue (\`target\`); \`comment_on_issue\` and \`get_pr_status\` (checks, reviews, mergeability). For anything else on GitHub (reading or editing issues, labels, checks, reviews) use the \`gh\` CLI, which is signed in as the user. GitHub has no API for uploading images, so \`gh\` can't attach screenshots: post them with \`attach_evidence\` (pass the \`File:\` path \`browser_screenshot\` prints, a file in your worktree, or an \`artifactId\`), and reuse the image URLs it returns if you also edit an issue or PR description with \`gh\`.
- If a CodeDen tool fails with "CodeDen server unreachable", CodeDen is restarting: wait a few seconds and call the same tool again.
- \`finish\`: record the outcome and a short summary once your assigned task is done.
- \`suggest_followups\`: 2 to 4 short next prompts the user might send, including optional next steps you would otherwise ask about. Call it as the last action of every turn.`;

/** Where the agent works: its own worktree, or a folder it shares with the user. */
function workspaceLine(session: PromptSession): string {
  return session.worktreePath
    ? "Your working directory is your own git worktree and branch."
    : "Your working directory is not a worktree of your own: it is the project's checkout or a folder the user chose, and the user may be working in it too.";
}

/**
 * The session's permission level (§11.2) in the agent's terms: what is already approved, and
 * that approvals ask the user by themselves, so the agent doesn't ask first.
 */
function permissionLine(session: PromptSession): string {
  const where = session.worktreePath ? "your worktree" : "your working directory";
  switch (session.autonomy) {
    case "read_only":
      return "- Your permission level is Read-only: you can read and run the project's checks, but not edit files, commit or push. Report what you found instead of asking to change things.";
    case "supervised":
      return "- Your permission level is Supervised: the user approves edits and commands as you make them, so go ahead and make them; don't ask before each one.";
    case "auto":
      return `- Your permission level is Auto: edits and commands inside ${where} are pre-approved, so go ahead. Risky actions ask the user for approval automatically, so you don't need to ask first.`;
    case "full":
      return `- Your permission level is Full: edits and commands inside ${where} are pre-approved, so go ahead. Anything outside it is refused or goes to the user for approval automatically, so you don't need to ask first.`;
  }
}

/** Committing and pull requests: free in the agent's own worktree, opt-in elsewhere. */
function gitLines(session: PromptSession, project: PromptProject): string[] {
  if (!session.worktreePath) {
    return [
      "- Others may be working in this directory: don't commit, switch branches, stash or discard changes unless you're asked to.",
    ];
  }
  if (session.autonomy === "read_only") return [];
  const lines = [
    "- This worktree and its branch are yours: edit files, run the project's checks and commit as you go without asking, unless your brief says otherwise.",
  ];
  if (project?.kind !== "github") return lines;
  lines.push(
    session.startedBy.kind === "user"
      ? "- Open a pull request with `create_pull_request` when the user asks for one; otherwise offer it with `suggest_followups` instead of asking."
      : "- When the work is done, open the pull request with `create_pull_request` (it links your issue), unless your brief says otherwise.",
  );
  return lines;
}

/** Who started the session, when it wasn't the user: the PM sees the agent's questions first. */
function starterLine(session: PromptSession): string | null {
  switch (session.startedBy.kind) {
    case "user":
      return null;
    case "pm":
      return '- Your project manager started this session and sees your questions first; it answers what it can. Its brief is your first message, its later messages start with "Message from your project manager:", and nobody may be watching live.';
    case "automation":
      return "- An automation started this session, not the user, and nobody may be watching live. Your project manager sees your questions first; it answers what it can.";
    case "orchestrator":
      return "- The orchestrator started this session, not the user. Your project manager sees your questions first; it answers what it can.";
  }
}

/** The agent's section of the system prompt (§8.3): how to work, then CodeDen's tools. */
export function agentPrompt(session: PromptSession, project: PromptProject): string {
  const lines = [
    "- Keep going until the task is done. When a detail is open (naming, structure, approach, test strategy, a choice between reasonable designs), pick what fits the brief and the project's conventions, note the assumption, and carry on. Don't ask about things you can decide yourself, check in the code, or easily change later.",
    permissionLine(session),
    ...gitLines(session, project),
    `- Ask with \`ask_user\` only for a decision that is the user's to make: ${USER_DECISIONS}. First do everything that doesn't depend on the answer, then ask one question with your recommended option first.`,
    starterLine(session),
    '- End each turn with what you did and what you assumed, not with a question. Put optional next steps in `suggest_followups` instead of asking "Want me to ...?".',
  ].filter((l): l is string => l !== null);
  return [
    "# Working inside CodeDen",
    "",
    `You are an agent session in CodeDen, a local harness that shows your work to the user live. ${workspaceLine(session)}`,
    "",
    "## How to work",
    "",
    ...lines,
    "",
    TOOLS,
  ].join("\n");
}

/** The CodeDen section appended to a session's system prompt, by role (§7.5, §8.3). */
export function codedenSystemPrompt(session: PromptSession, project: PromptProject): string {
  return session.role === "agent" ? agentPrompt(session, project) : rolePrompt(session.role);
}
