import { z } from "zod";
import { defineTool, ToolError } from "../define";
import { projectFor } from "./shared/helpers";

/** Read the same ledger the owner sees, scoped to the PM's project when called by a PM. */
export const listTechDebt = defineTool({
  name: "list_tech_debt",
  description:
    "List LOW review findings and their status. Pass projectId as the orchestrator. A PM always reads its own project.",
  roles: ["pm", "orchestrator"],
  scope: "global",
  input: z.strictObject({ projectId: z.string().min(1).optional() }),
  handler: async (input, { services, role, projectId }) => {
    const id = role === "pm" ? projectId : input.projectId;
    if (!id || (role === "pm" && input.projectId && input.projectId !== id)) {
      throw new ToolError("Give an accessible project id");
    }
    return services.techDebt.list(projectFor(services, id));
  },
});
