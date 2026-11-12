/** State of the fake GitHub (`fake-github.ts`). */

export interface FakeCheck {
  name: string;
  status: "QUEUED" | "IN_PROGRESS" | "COMPLETED";
  conclusion: "SUCCESS" | "FAILURE" | null;
}

export interface FakeReview {
  id: string;
  author: string;
  /** GitHub's `CommentAuthorAssociation`; default `COLLABORATOR`. */
  authorAssociation?: "OWNER" | "MEMBER" | "COLLABORATOR" | "CONTRIBUTOR" | "NONE";
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  body: string;
  submittedAt: string;
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  author: string;
  comments: Array<{ id: number; body: string; author: string; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  pr?: {
    head: string;
    base: string;
    headSha: string;
    draft: boolean;
    merged: boolean;
    mergedAt: string | null;
    checks: FakeCheck[];
    reviews: FakeReview[];
    /** Pending review requests (logins). */
    requestedReviewers?: string[];
    mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  };
}
