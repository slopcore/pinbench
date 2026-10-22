/**
 * The value type for an Inspector config field. Its own module so it can outlive
 * the `.pinbench` project file: `shared/project.ts` re-exports it for now, and
 * the per-folder session state (`src/main/store.ts`) is the long-term home for
 * the `${partId}.${fieldId}` → value map it keys.
 */
export type PartConfigValue = string | number | boolean
