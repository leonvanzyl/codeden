import type { TechDebtView } from "@codeden/contracts";
import type { TechDebtApi } from "../tech-debt-api";

export function mockTechDebtApi(): TechDebtApi {
  const views = new Map<string, TechDebtView>();
  const list = (projectId: string): TechDebtView =>
    views.get(projectId) ?? { projectId, issue: null, imported: false, findings: [] };
  return {
    list: async (id) => list(id),
    act: async (id, action) => {
      const view = list(id);
      switch (action.action) {
        case "configure":
          view.issue = action.issue;
          break;
        case "record":
          view.findings = [
            ...view.findings,
            {
              ...action.finding,
              id: crypto.randomUUID(),
              source: null,
              status: "open",
              reason: null,
              sessionId: null,
            },
          ];
          break;
        case "fix":
          view.findings = view.findings.map((finding) =>
            action.ids.includes(finding.id) ? { ...finding, status: "in_progress" } : finding,
          );
          break;
        case "fixed":
        case "dismiss":
          view.findings = view.findings.map((finding) =>
            finding.id === action.id
              ? {
                  ...finding,
                  status: action.action === "fixed" ? "fixed" : "dismissed",
                  reason: action.action === "dismiss" ? action.reason : null,
                }
              : finding,
          );
      }
      views.set(id, view);
      return { ...view };
    },
  };
}
