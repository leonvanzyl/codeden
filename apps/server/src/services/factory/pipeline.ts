import type {
  FactoryAnalysisReport,
  FactoryItem,
  FactoryReproductionReport,
  Investigation,
  Session,
} from "@codeden/contracts";
import { badRequest, errorMessage } from "../errors";
import { type FactoryContext, raiseInbox } from "./context";
import { fixStep, implementStep } from "./prompts";

/**
 * The first step of the bug and feature pipelines (§10.1). The builder reproduces the bug or
 * analyzes the feature request and reports it; the answer to that tool call is the next step
 * (Create fix, Implement feature), so the same session carries on in the same turn. A bug that
 * doesn't reproduce, or a request that is done already, unclear or out of scope, stops here
 * with a comment on the issue.
 */

function builderItem(ctx: FactoryContext, session: Session): FactoryItem {
  const item = session.projectId
    ? ctx.store
        .items(session.projectId, ["building"])
        .find((i) => i.builderSessionId === session.id)
    : undefined;
  if (!item) throw badRequest("You are not building a factory work item", "not_a_builder");
  return item;
}

function details(...parts: Array<[string, string | undefined]>): string | null {
  const text = parts
    .filter(([, v]) => v?.trim())
    .map(([label, v]) => `${label}:\n${v?.trim()}`)
    .join("\n\n");
  return text ? text.slice(0, 12_000) : null;
}

async function comment(ctx: FactoryContext, item: FactoryItem, body: string): Promise<void> {
  if (!item.issue) return;
  await ctx.github
    .comment(item.projectId, item.issue.number, body)
    .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
}

/** Stop an item after its first step, telling the issue and the user why. */
async function stopAfterInvestigation(
  ctx: FactoryContext,
  item: FactoryItem,
  investigation: Investigation,
  reason: string,
  issueText: string,
): Promise<void> {
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "rejected",
    investigation,
    reason,
    note: null,
    finishedAt: ctx.now().toISOString(),
  }));
  await comment(ctx, item, issueText);
  raiseInbox(ctx, {
    id: `inbox:factory-stopped:${item.id}`,
    kind: "automation_result",
    notify: "factory",
    priority: "low",
    projectId: item.projectId,
    sessionId: item.builderSessionId,
    issue: item.issue,
    title: `Factory stopped: ${item.title}`,
    body: `${reason}. Retry it from the factory panel once the issue has what it needs.`,
  });
}

/** `factory_report_reproduction`: the bug pipeline's Reproduce step. */
export async function reportReproduction(
  ctx: FactoryContext,
  session: Session,
  report: FactoryReproductionReport,
): Promise<{ recorded: boolean; next: string }> {
  const item = builderItem(ctx, session);
  if (item.type !== "bug") {
    throw badRequest(`This is a ${item.type ?? "untyped"} item, not a bug`, "wrong_pipeline");
  }
  if (item.investigation) {
    return { recorded: false, next: `Already recorded. Carry on:\n\n${fixStep(item)}` };
  }
  const investigation: Investigation = {
    kind: "reproduction",
    outcome: report.reproduced ? "reproduced" : "not_reproduced",
    summary: report.summary,
    details: details(["Steps", report.steps], ["Output", report.evidence]),
    testPath: report.testPath?.trim() || null,
    at: ctx.now().toISOString(),
  };
  if (!report.reproduced) {
    await stopAfterInvestigation(
      ctx,
      item,
      investigation,
      `Could not reproduce: ${report.summary}`,
      [
        "**CodeDen software factory**: I could not reproduce this.",
        "",
        report.summary,
        report.steps
          ? `\n<details><summary>What I tried</summary>\n\n${report.steps}\n\n</details>`
          : "",
        "",
        "Please add what's missing (versions, exact steps, expected and actual behaviour). A maintainer can then retry it from CodeDen.",
      ].join("\n"),
    );
    return {
      recorded: true,
      next: "Recorded as not reproduced. The item stops here and the issue asks for more information. Call `finish` now with outcome `blocked`.",
    };
  }
  const updated = ctx.store.updateItem(item.id, (i) => ({ ...i, investigation, note: null }));
  await comment(
    ctx,
    item,
    [
      `**CodeDen software factory**: reproduced. ${report.summary}`,
      investigation.testPath ? `\nReproduction: \`${investigation.testPath}\`` : "",
      report.evidence
        ? `\n<details><summary>Failing output</summary>\n\n\`\`\`text\n${report.evidence.replace(/```/g, "ʼʼʼ").slice(0, 6_000)}\n\`\`\`\n\n</details>`
        : "",
      "\nNext: Create fix.",
    ].join("\n"),
  );
  return { recorded: true, next: fixStep(updated) };
}

const STOP_REASON: Record<Exclude<FactoryAnalysisReport["decision"], "implement">, string> = {
  already_done: "Already possible",
  needs_info: "Needs more information",
  out_of_scope: "Out of scope for the vision",
};

/** `factory_submit_analysis`: the feature pipeline's Analyze step. */
export async function submitAnalysis(
  ctx: FactoryContext,
  session: Session,
  report: FactoryAnalysisReport,
): Promise<{ recorded: boolean; next: string }> {
  const item = builderItem(ctx, session);
  if (item.type !== "feature") {
    throw badRequest(`This is a ${item.type ?? "untyped"} item, not a feature`, "wrong_pipeline");
  }
  if (item.investigation) {
    return { recorded: false, next: `Already recorded. Carry on:\n\n${implementStep(item)}` };
  }
  const investigation: Investigation = {
    kind: "analysis",
    outcome: report.decision,
    summary: report.summary,
    details: report.spec?.trim().slice(0, 12_000) || null,
    testPath: null,
    at: ctx.now().toISOString(),
  };
  if (report.decision !== "implement") {
    const label = STOP_REASON[report.decision];
    await stopAfterInvestigation(
      ctx,
      item,
      investigation,
      `${label}: ${report.summary}`,
      [
        `**CodeDen software factory**: analyzed, and not building it. **${label}.**`,
        "",
        report.summary,
        "",
        "A maintainer can retry it from CodeDen once that changes.",
      ].join("\n"),
    );
    return {
      recorded: true,
      next: "Recorded. The item stops here and the issue says why. Call `finish` now with outcome `blocked`.",
    };
  }
  const updated = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    investigation,
    acceptanceCriteria: report.acceptanceCriteria ?? i.acceptanceCriteria,
    note: null,
  }));
  await comment(
    ctx,
    item,
    [
      `**CodeDen software factory**: analyzed. ${report.summary}`,
      "",
      "<details><summary>Spec</summary>",
      "",
      investigation.details ?? "",
      "",
      "</details>",
      "",
      "Acceptance criteria:",
      ...updated.acceptanceCriteria.map((c) => `- [ ] ${c}`),
      "",
      "Next: Implement.",
    ].join("\n"),
  );
  return { recorded: true, next: implementStep(updated) };
}
