/**
 * Pure, side-effect-free layout query for the Live Workspace pane, split out of
 * `live-workspace.ts` (which has import-time side effects: binding listeners and starting a
 * ticking interval) so it can be unit-tested without triggering that bootstrap (O11).
 */

/**
 * The docked breakpoint, the exact media query live-workspace.css docks the pane under
 * (`@media (width >= 64rem)`). It is a viewport query, not `@container workspace`:
 * `#workspace-shell` IS the `workspace` container, and a container query never matches its
 * own container, so the old shell-width rule never applied (flow-spec §5). With Live open,
 * Sessions is closed, so the viewport width is the shell width. Shared with pane-motion.ts.
 */
export const dockedLiveQuery = "(width >= 64rem)";

/**
 * True while the pane WOULD render docked (grid-folded, not an overlay to dismiss) at the
 * current viewport width, whether or not it's actually open right now: used to decide whether
 * the persisted `open` preference should auto-restore on load (O10), because a docked-desktop
 * preference must not pop open as a phone/tablet sheet covering the chat.
 *
 * `matchMedia` evaluates the same query the CSS uses, so the two cannot drift (flow-critique
 * #12a: measuring `#workspace-shell` read "not docked" between 1024 and 1312px whenever the
 * Sessions reserve narrowed the shell, and force-closed a pane the CSS would dock).
 */
export function isDockedLayout(): boolean {
	return globalThis.matchMedia?.(dockedLiveQuery).matches === true;
}
