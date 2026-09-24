/**
 * Sessions and Live Workspace share the right-hand area of the workspace shell and must never
 * both be open at once (PLAN-ux.md "sidebar-exclusive": before this rule, both could be shown
 * together and visually collided). Saved configs from before this rule existed can carry
 * `sessionSidebar.open` and `liveWorkspace.open` as two independently-toggled booleans, so an old
 * config can have both `true`. This resolves that conflict once, deterministically, at load:
 * Sessions wins. It's the primary, always-available surface and defaults to open, so a `true`
 * left on Live Workspace alongside it is the one assumed stale/incidental rather than a real,
 * still-wanted choice.
 */
export type RightPaneOpenState = Readonly<{
	sessionSidebarOpen: boolean;
	liveWorkspaceOpen: boolean;
}>;

export function resolveExclusiveRightPane(
	sessionSidebarOpen: boolean,
	liveWorkspaceOpen: boolean,
): RightPaneOpenState {
	if (sessionSidebarOpen && liveWorkspaceOpen) {
		return { sessionSidebarOpen, liveWorkspaceOpen: false };
	}
	return { sessionSidebarOpen, liveWorkspaceOpen };
}
