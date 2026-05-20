/**
 * lib/locale.js — Locale-aware collator and sort helpers
 *
 * Single collator instance — do not recreate per call.
 * Using sensitivity:"base" means case and accents are ignored for ordering.
 * numeric:true means "10" sorts after "9" rather than after "1".
 */

export const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

/**
 * Sort an array of objects by their `title` property using the collator.
 * Returns a NEW sorted array — does NOT mutate the input.
 *
 * @param {Array<{title: string, [key: string]: any}>} items
 * @returns {Array<{title: string, [key: string]: any}>}
 */
export function sortByTitle(items) {
  return [...items].sort((a, b) => collator.compare(a.title ?? "", b.title ?? ""));
}
