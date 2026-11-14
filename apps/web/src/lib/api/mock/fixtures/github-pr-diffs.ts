import type { GithubPrDetails, GithubPrDiff, GithubPrFile } from "@codeden/contracts";
import { countLines, indexPatch, normalizePatch, searchPatch, tokensPatch } from "./patches";

const productPatch = normalizePatch(`diff --git a/src/pages/product.tsx b/src/pages/product.tsx
--- a/src/pages/product.tsx
+++ b/src/pages/product.tsx
@@ -22,12 +22,18 @@ export function ProductPage({ product }: { product: Product }) {
   return (
     <main className="product">
       <div className="gallery">
         {product.images.map((src) => (
-          <img key={src} src={src} />
+          <img key={src} src={src} alt={product.imageAlt[src] ?? product.name} />
         ))}
       </div>
-      <button className="add-to-cart" onClick={add}>
+      <button
+        type="button"
+        className="add-to-cart focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
+        onClick={add}
+      >
         Add to cart
       </button>
-      <span className="price muted">{formatPrice(product.price)}</span>
+      <span className="price">{formatPrice(product.price)}</span>
+      <span className="sr-only">Price including tax</span>
     </main>
   );
 }
`);

const cdnPatch = normalizePatch(`diff --git a/infra/cdn.ts b/infra/cdn.ts
--- a/infra/cdn.ts
+++ b/infra/cdn.ts
@@ -3,7 +3,13 @@ import { defineCdn } from "./lib/cdn";
 export const imageCdn = defineCdn({
   origin: "https://images.hearth.co",
-  allowedTypes: ["image/png", "image/jpeg"],
+  allowedTypes: ["image/png", "image/jpeg", "image/webp"],
   cacheTtlSeconds: 86_400,
+  vary: ["Accept"],
+  negotiate: {
+    // Serve webp to browsers that ask for it, the original format to the rest.
+    "image/webp": { accept: /image\\/webp/ },
+  },
 });
`);

/** Patches of the mock PRs' files by path; files missing here have none (binary). */
const PATCHES: Record<string, string> = {
  "src/pages/product.tsx": productPatch,
  "src/theme/tokens.css": tokensPatch,
  "src/search/SearchFilters.tsx": searchPatch,
  "src/search/index.ts": indexPatch,
  "infra/cdn.ts": cdnPatch,
};

/** A mock PR file, with its line counts taken from its patch. */
export function mockPrFile(path: string, status: string): GithubPrFile {
  const patch = PATCHES[path];
  return { path, status, ...(patch ? countLines(patch) : { additions: 0, deletions: 0 }) };
}

/** `/api/prs/:id/diff` for a mock PR. */
export function mockPrDiff(pr: GithubPrDetails): GithubPrDiff {
  return {
    headSha: pr.headSha,
    changedFiles: pr.changedFiles,
    files: pr.files.map((f) => ({ ...f, patch: PATCHES[f.path] ?? null })),
  };
}
