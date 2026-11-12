import type { EventEnvelope, NewEvent } from "@codeden/contracts";
import { eq } from "drizzle-orm";
import { automationToRow, inboxToRow, projectToRow, runToRow, sessionToRow } from "../db/rows";
import {
  artifacts,
  automationRuns,
  automations,
  inboxItems,
  projects,
  sessions,
} from "../db/schema";
import { applyFactoryProjection } from "../services/factory/projection";
import {
  applyGithubProjection,
  githubRepoChanged,
  resetGithubProjection,
} from "../services/github/projection";
import { applyOrchestrationProjection } from "../services/orchestration/projection";
import { indexUnfinishedItems } from "../services/search/index-writer";
import { applyUsageReport } from "../services/usage/ledger";
import { applyMutations, DbProjectionReader, derivedEvents, type Tx } from "./projection-db";
import { reduceAgentEvent } from "./reducer/agent";
import { applyWorkbenchProjection } from "./workbench-projection";

export type { Tx } from "./projection-db";
export { applyDelta } from "./reducer/items";

/**
 * Update projections for one stored event, inside the append transaction (§6), so
 * projections can always be rebuilt by replaying the log through this function.
 *
 * Agent events go through the pure reducer; the session and inbox changes it produces are
 * returned as derived domain events (`session.updated`, `inbox.*`), which the store appends
 * right after in the same transaction. Domain events never derive further events.
 */
export function applyProjection(tx: Tx, e: EventEnvelope): NewEvent[] {
  switch (e.type) {
    case "project.created":
    case "project.updated": {
      const { project } = e.payload;
      const before = tx
        .select({ github: projects.github })
        .from(projects)
        .where(eq(projects.id, project.id))
        .get();
      // Another repository behind the project: its old issues and PRs don't belong to it.
      if (githubRepoChanged(before, project)) resetGithubProjection(tx, project.id);
      const row = projectToRow(project);
      tx.insert(projects).values(row).onConflictDoUpdate({ target: projects.id, set: row }).run();
      return [];
    }
    case "project.archived":
      tx.update(projects)
        .set({ archivedAt: e.ts, updatedAt: e.ts })
        .where(eq(projects.id, e.payload.projectId))
        .run();
      return [];
    case "projects.reordered":
      e.payload.projectIds.forEach((id, index) => {
        tx.update(projects).set({ sortOrder: index }).where(eq(projects.id, id)).run();
      });
      return [];
    case "session.created":
    case "session.updated": {
      const row = sessionToRow(e.payload.session);
      tx.insert(sessions).values(row).onConflictDoUpdate({ target: sessions.id, set: row }).run();
      return [];
    }
    case "inbox.created":
    case "inbox.updated": {
      const row = inboxToRow(e.payload.item);
      tx.insert(inboxItems)
        .values(row)
        .onConflictDoUpdate({ target: inboxItems.id, set: row })
        .run();
      return [];
    }
    case "automation.saved": {
      const row = automationToRow(e.payload.automation);
      tx.insert(automations)
        .values(row)
        .onConflictDoUpdate({ target: automations.id, set: row })
        .run();
      return [];
    }
    case "automation.deleted":
      tx.delete(automations).where(eq(automations.id, e.payload.automationId)).run();
      return [];
    case "automation_run.updated": {
      const row = runToRow(e.payload.run);
      tx.insert(automationRuns)
        .values(row)
        .onConflictDoUpdate({ target: automationRuns.id, set: row })
        .run();
      return [];
    }
    case "artifact.created":
      tx.insert(artifacts).values(e.payload.artifact).onConflictDoNothing().run();
      return [];
    case "session.setup":
    case "checkpoint.created":
    case "message.queued":
    case "message.dequeued":
    case "message.edited":
      applyWorkbenchProjection(tx, e);
      return [];
    case "notice.created":
    case "notice.delivered":
    case "notice.returned":
    case "conflict.created":
      applyOrchestrationProjection(tx, e);
      return [];
    case "github.synced":
    case "issue.opened":
    case "issue.labeled":
    case "issue.updated":
    case "issue.commented":
    case "pr.opened":
    case "pr.updated":
    case "pr.review_requested":
    case "pr.checks_passed":
    case "pr.checks_failed":
    case "pr.merged":
    case "pr.closed":
    case "review.submitted":
      applyGithubProjection(tx, e);
      return [];
    case "factory.loop.updated":
    case "factory.item.updated":
    case "factory.digest.created":
      applyFactoryProjection(tx, e);
      return [];
    case "settings.updated":
    case "automation.updated":
    case "runner.connected":
    case "runner.disconnected":
    case "runner.draining":
    case "pty.exited":
      return [];
    default: {
      const mutations = reduceAgentEvent(new DbProjectionReader(tx), e.sessionId, e.payload, e.ts);
      applyMutations(tx, mutations, { index: e.payload.type !== "item.delta" });
      if (
        e.payload.type === "turn.completed" ||
        e.payload.type === "turn.failed" ||
        e.payload.type === "turn.interrupted"
      ) {
        indexUnfinishedItems(tx, e.sessionId, e.payload.turnId);
      }
      if (e.payload.type === "usage.updated") {
        const { threadId, turnId, usage } = e.payload;
        applyUsageReport(tx, { sessionId: e.sessionId, threadId, turnId, usage, ts: e.ts });
      }
      return derivedEvents(mutations);
    }
  }
}
