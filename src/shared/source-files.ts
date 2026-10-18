/**
 * File extensions the analyzer reads. This module has no imports on purpose: the agent hook's no-op path
 * (`hook pre-edit` for a Markdown edit) checks a path against it without loading anything else.
 */

/** Source files the analyzer parses: JavaScript / TypeScript (`.js` `.mjs` `.cts` `.tsx` …) and Vue, Svelte and Astro components. */
export const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;

/** Plain script files: `.js`, `.jsx`, `.ts`, `.tsx` and their `.c*` / `.m*` variants (no components). */
export const SCRIPT_EXT_RE = /\.[cm]?[jt]sx?$/i;

/** Single-file components whose script sits in a block of the markup: Vue, Svelte and Astro. */
export const COMPONENT_FILE_RE = /\.(?:vue|svelte|astro)$/i;
