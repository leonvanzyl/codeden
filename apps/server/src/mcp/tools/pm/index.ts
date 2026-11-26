import type { AnyServerTool } from "../../define";
import { createAutomation, updateAutomation } from "./automation-edit";
import { listAutomations, reportTriage, runAutomation } from "./automations";
import { createIssue, getIssue, listIssues, triageIssue } from "./github";
import { listInboxItems, resolveInboxItem } from "./inbox";
import { messageOrchestrator, readProjectNotes, updateProjectNotes } from "./notes";
import { answerQuestion } from "./questions";
import { getSession } from "./session-detail";
import { listSessions, messageSession, startSession, stopSession } from "./sessions";
import {
  cancelQueuedRun,
  getProjectStatus,
  listScheduledRuns,
  pauseAutomation,
  resumeAutomation,
  skipNextRun,
} from "./status";

/**
 * Project manager tools (§8.3, §8.4). `ask_user` is shared with agents (`../ask-user`) and
 * `get_pr_status` with agents (`../github`).
 */
export const pmTools: AnyServerTool[] = [
  getProjectStatus,
  listSessions,
  getSession,
  startSession,
  messageSession,
  stopSession,
  answerQuestion,
  listInboxItems,
  resolveInboxItem,
  listScheduledRuns,
  skipNextRun,
  pauseAutomation,
  resumeAutomation,
  cancelQueuedRun,
  messageOrchestrator,
  readProjectNotes,
  updateProjectNotes,
  listIssues,
  getIssue,
  triageIssue,
  createIssue,
  listAutomations,
  runAutomation,
  createAutomation,
  updateAutomation,
  reportTriage,
];
