/**
 * BaselineAdapter — pluggable "pre-citare" pipeline the harness compares
 * against citare-solo and citare-post (citare with host-app fallbacks).
 *
 * Consumers supply a module whose default export is a factory returning
 * a BaselineAdapter. The harness loads the module via `await import()`
 * when `config.baseline.enabled` is true and `config.baseline.modulePath`
 * is set; otherwise the `baseline_pre` / `citare_solo` pre-columns are
 * omitted and only the citare-post column is reported.
 *
 * Adapters advertise only the ops they support — each method is optional
 * on the adapter and independently disable-able per op. Missing methods
 * → the harness skips that op's pre column (still runs solo + post).
 *
 * Use `noBaselineAdapter()` below as the default for a bare citare-service
 * eval run where there's no host-app pipeline to compare against.
 */

import type { CslJson } from "citare";

/**
 * `Partial<CslJson>` is the shape citare's own extraction pipelines return
 * (types.d.ts §398) — not every expected field is always populated.
 * Adapters match the same shape.
 */
export type Csl = Partial<CslJson>;

export interface BaselineAdapter {
  /** Short identifier that flows into result filenames and summary docs. */
  name: string;
  /** DOI → CSL-JSON. Return null on failure; the harness records null. */
  doiLookup?(doi: string): Promise<Csl | null>;
  /** RIS text → CSL-JSON. Synchronous; host pipelines are typically pure. */
  parseRis?(ris: string): Csl | null;
  /** Legacy pre-CSL-1.0.1 hash → CSL-JSON. */
  upgradeLegacyBib?(bib: Record<string, unknown>): Csl | null;
  /** CrossRef title + author free-text search. */
  freetextSearch?(
    author: string | null,
    title: string | null,
    max: number,
  ): Promise<Csl[]>;
  /** URL → CSL-JSON via host-app metadata extraction. */
  extractUrl?(url: string): Promise<Csl | null>;
}

export type BaselineAdapterFactory = () =>
  | BaselineAdapter
  | Promise<BaselineAdapter>;

/**
 * Default adapter for a bare citare-service eval run. Advertises no ops,
 * which collapses the harness's output to a single column (post-citare).
 */
export function noBaselineAdapter(): BaselineAdapter {
  return { name: "none" };
}

export default noBaselineAdapter;
