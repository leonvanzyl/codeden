import { z } from "zod";
import { Id, Timestamp } from "./common";

/** Optional tracking issue, independently configurable for each project. */
export const TechDebtIssue = z
  .string()
  .trim()
  .regex(/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+#[1-9]\d{0,14}$/i);

/** A LOW review finding, with nullable metadata for older issue entries. */
export const TechDebtFindingInput = z.object({
  location: z.string().trim().min(1).max(500).regex(/:\d+$/),
  text: z.string().trim().min(1).max(4000),
  receipt: z.string().trim().min(1).max(1000).nullable(),
  date: Timestamp,
  pr: z.string().trim().min(1).max(500).nullable(),
});

/** Local state and the source identity used to synchronize an imported checklist entry. */
export const TechDebtFinding = TechDebtFindingInput.extend({
  id: Id,
  source: TechDebtIssue.nullable(),
  status: z.enum(["open", "in_progress", "fixed", "dismissed"]),
  reason: z.string().nullable(),
  sessionId: Id.nullable(),
});
export type TechDebtFinding = z.infer<typeof TechDebtFinding>;

/** The project settings and durable findings read by the panel and MCP. */
export const TechDebtView = z.object({
  projectId: Id,
  issue: TechDebtIssue.nullable(),
  imported: z.boolean(),
  findings: z.array(TechDebtFinding),
});
export type TechDebtView = z.infer<typeof TechDebtView>;

/** Updates from the project panel or a local review hand-off. */
export const TechDebtAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), issue: TechDebtIssue.nullable() }),
  z.object({ action: z.literal("record"), finding: TechDebtFindingInput }),
  z.object({
    action: z.literal("fix"),
    ids: z
      .array(Id)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
  z.object({ action: z.literal("fixed"), id: Id }),
  z.object({ action: z.literal("dismiss"), id: Id, reason: z.string().trim().min(1).max(1000) }),
]);
export type TechDebtAction = z.infer<typeof TechDebtAction>;

/** A local update can succeed even when its tracking issue could not be synchronized. */
export const TechDebtActionResult = TechDebtView.extend({ syncError: z.string().optional() });
export type TechDebtActionResult = z.infer<typeof TechDebtActionResult>;

/** A failed import leaves the local view available and can be retried. */
export const TechDebtList = TechDebtView.extend({ importError: z.string().optional() });
export type TechDebtList = z.infer<typeof TechDebtList>;
