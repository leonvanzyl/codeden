import { TranscriptSearchQuery, type TranscriptSearchResponse } from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { searchTranscripts } from "../services/search/search";
import { queryOf } from "./validate";

/** `/api/search`: full-text search over transcripts (§13). */
export function searchRoutes(s: AppServices) {
  return new Hono().get("/transcripts", queryOf(TranscriptSearchQuery), (c) => {
    const body: TranscriptSearchResponse = searchTranscripts(s.db, c.req.valid("query"));
    return c.json(body);
  });
}
