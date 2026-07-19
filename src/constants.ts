/**
 * @module constants
 * Shared constants used across pipeline modules.
 */

/** Paths that agents in loop stages (develop/fix) must not modify */
export const PROTECTED_PATHS = [".pi/", "AGENTS.md", ".git/"] as const;
