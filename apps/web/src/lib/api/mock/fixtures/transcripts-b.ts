import type { TranscriptState } from "@/lib/transcript/reducer";
import { buildTranscript } from "./helpers";
import {
  assistant,
  brief,
  cmd,
  edit,
  fromRole,
  mcp,
  notice,
  read,
  search,
  thought,
  user,
  web,
} from "./item-builders";

export const webhooksTranscript = buildTranscript(
  "s-webhooks",
  [{ id: "t-webhooks", title: "Retry failed payment webhooks" }],
  [
    {
      id: "wh-turn-1",
      threadId: "t-webhooks",
      start: 25,
      status: "running",
      items: [
        user(
          "wh-u1",
          "Fix #88: failed payment webhooks are never retried. Use our existing job queue.",
        ),
        read("wh-t1", "src/webhooks/handler.ts"),
        read("wh-t2", "src/jobs/queue.ts"),
        web("wh-t3", "https://docs.stripe.com/webhooks#retries", "Read provider retry guidance"),
        assistant(
          "wh-a1",
          "The queue already supports delayed jobs, so retries are cheap to add. Two decisions change the design, so I'd rather ask than guess.",
        ),
        {
          id: "wh-question",
          kind: "user_question",
          status: "in_progress",
          requestId: "req-wh",
          questions: [
            {
              id: "q-strategy",
              header: "Strategy",
              question: "How should failed webhooks be retried?",
              options: [
                {
                  label: "Exponential backoff",
                  description: "5 tries over ~1 hour (1m, 4m, 10m, 20m, 30m)",
                },
                { label: "Fixed interval", description: "Every 10 minutes, up to 6 tries" },
                { label: "Provider-driven", description: "Return 500 and let the provider retry" },
              ],
              multiSelect: false,
              allowFreeText: true,
            },
            {
              id: "q-dead",
              header: "After retries",
              question: "What should happen once retries are exhausted?",
              options: [
                { label: "Dead-letter table", description: "Keep the payload for manual replay" },
                { label: "Inbox alert", description: "Raise a CodeDen inbox item" },
                { label: "Email on-call" },
              ],
              multiSelect: true,
              allowFreeText: false,
            },
          ],
        },
      ],
    },
  ],
);

export const depsTranscript = buildTranscript(
  "s-deps",
  [{ id: "t-deps", title: "Dependency updates" }],
  [
    {
      id: "dp-turn-1",
      threadId: "t-deps",
      start: 300,
      end: 288,
      status: "failed",
      items: [
        user(
          "dp-u1",
          "Automation · Dependency updates. Apply patch and minor updates, run the tests, open a PR.",
        ),
        cmd(
          "dp-t1",
          "pnpm outdated --format json",
          "12 packages have updates (9 minor, 3 patch)",
          0,
          3_100,
        ),
        cmd(
          "dp-t2",
          "pnpm up --latest '!react' '!react-dom'",
          " ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies\n\n└─┬ @tanstack/react-query 6.0.1\n  └── ✕ unmet peer react@^19.2.0: found 19.1.4",
          1,
          14_200,
        ),
        {
          id: "dp-err",
          kind: "error",
          status: "failed",
          error: {
            code: "command_failed",
            message: "pnpm up failed with unmet peer dependencies.",
            detail: "@tanstack/react-query 6.0.1 requires react@^19.2.0 (found 19.1.4).",
            retryable: true,
          },
        },
      ],
    },
  ],
);

export const auditTranscript = buildTranscript(
  "s-audit",
  [{ id: "t-audit", title: "Weekly security audit" }],
  [
    {
      id: "au-turn-1",
      threadId: "t-audit",
      start: 18,
      status: "running",
      items: [
        user(
          "au-u1",
          "Automation · Security audit. Review changes since last week across the 7 audit areas and report findings.",
        ),
        thought("au-r1", "Listing the commits since the last audit"),
        cmd(
          "au-t1",
          "git log --since='7 days ago' --stat --oneline",
          "41 commits · 118 files changed",
          0,
          600,
        ),
        search("au-t2", "req.cookies|jwt.verify", 11, "src/server"),
        read("au-t3", "src/server/middleware/auth.ts"),
        mcp(
          "au-t4",
          "codeden",
          "report_progress",
          "Report progress",
          "Reviewing auth middleware (3 of 7 areas)",
        ),
      ],
    },
  ],
);

export const pmStorefrontTranscript = buildTranscript(
  "s-pm-storefront",
  [{ id: "t-pm-storefront", title: "Storefront PM" }],
  [
    {
      id: "pm-turn-0",
      threadId: "t-pm-storefront",
      start: 95,
      end: 93,
      items: [
        // Stored before senders were recorded: only the first line names the orchestrator.
        user(
          "pm-u0",
          [
            '<codeden_status project="p-storefront" at="2026-11-08T08:25:00.000Z">',
            "Running: Fix flaky checkout e2e test",
            "</codeden_status>",
            "",
            "Message from the orchestrator:",
            "The user wants the **checkout flake** fixed before Friday's release.",
            "",
            "- Keep `s-checkout` going and have it open a PR",
            "- Hold back new storefront work until it merges",
          ].join("\n"),
        ),
        assistant(
          "pm-a0",
          "Understood. The checkout session is close: it found a race in `useCart` and is verifying the fix. I'll hold new work until its PR merges.",
        ),
      ],
    },
    {
      id: "pm-turn-1",
      threadId: "t-pm-storefront",
      start: 40,
      end: 39,
      items: [
        notice(
          "pm-n1",
          "Updates since your last turn: issue #151 opened · PR #58 checks passed · session “Dependency updates” failed",
          "info",
          "wake",
        ),
        mcp("pm-t1", "codeden", "triage_issue", "Triage #151", "ready · labels: enhancement, ui"),
        mcp("pm-t2", "codeden", "ask_user", "Ask the user about #151", "Inbox item created"),
        assistant(
          "pm-a1",
          "Triaged #151 as **ready** and asked you whether to take it on. PR #58 passed every merge check except the human review required by the protected `src/payments/**` rule — it doesn't touch payments, so it's waiting on your normal review.",
        ),
      ],
    },
  ],
);

export const exportTranscript = buildTranscript(
  "s-export",
  [{ id: "t-export", title: "Export notes to Markdown" }],
  [
    {
      id: "ex-turn-1",
      threadId: "t-export",
      start: 60 * 26,
      end: 60 * 25 + 20,
      items: [
        brief(
          "ex-u1",
          "pm",
          [
            "## Goal",
            "Add `notes export --format md` that writes **one Markdown file per note** with front matter.",
            "",
            "<context>",
            "Users asked for a way to move their notes into a static site.",
            "</context>",
            "",
            "## Acceptance criteria",
            "- Each note becomes `<slug>.md` in the target folder",
            "- Front matter holds the title, tags and dates",
            "- `cargo test` passes",
            "",
            "## Decisions",
            "1. Overwrite existing files only with `--force`.",
            "2. Keep the change in `src/commands/export.rs`.",
            "3. Open a pull request when done; don't ask me first.",
            "",
            "Report back with `finish` and the test results.",
          ].join("\n"),
        ),
        read("ex-t1", "src/commands/export.ts"),
        cmd("ex-t2", "cargo test export", "test result: ok. 14 passed; 0 failed", 0, 21_000),
        assistant(
          "ex-a1",
          "Added `notes export --format md`. Each note becomes `<slug>.md` with title, tags and dates in YAML front matter. 14 tests pass.",
        ),
      ],
    },
    {
      id: "ex-turn-2",
      threadId: "t-export",
      start: 60 * 25 + 15,
      end: 60 * 25,
      items: [
        fromRole(
          "ex-u2",
          "pm",
          [
            "Looks good. Before you finish, **two small things** from the user:",
            "",
            "1. Slugs must stay ASCII: run titles through `slug::slugify`.",
            "2. Add a line about the new flag to the [README](https://github.com/acme/notes-cli#export).",
            "",
            "Then call `finish` with the test results.",
          ].join("\n"),
        ),
        edit("ex-t3", [{ path: "src/commands/export.rs", change: "modify", additions: 4 }]),
        cmd("ex-t4", "cargo test export", "test result: ok. 15 passed; 0 failed", 0, 19_000),
        assistant(
          "ex-a2",
          "Slugs now go through `slug::slugify`, with a test for a title with accents, and the README documents `--format md`. 15 tests pass.",
        ),
      ],
    },
  ],
);

/** Empty transcript for sessions without fixture history. */
export function emptyFor(sessionId: string, threadId: string): TranscriptState {
  return buildTranscript(sessionId, [{ id: threadId }], []);
}
