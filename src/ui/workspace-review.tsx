import { activeKeybind, keybindActions, keybindAria } from "../keybinds.ts";
import type { WorkspaceGitGraphSnapshot } from "../workspace-git-graph-types.ts";
import {
	gitPaneRatioDefault,
	gitPaneRatioMax,
	gitPaneRatioMin,
	reviewSidebarWidthDefault,
	reviewSidebarWidthMax,
	reviewSidebarWidthMin,
	type WorkspaceReviewPreferences,
	type WorkspaceReviewSnapshot,
} from "../workspace-review-types.ts";
import { Icon } from "./icon.tsx";
import { TextWrap, X } from "./icons.ts";
import { ShortcutKbd } from "./keyboard.tsx";
import { syncHtml } from "./sync-html.ts";

type ResizePreference = "changesRatio" | "gitPaneRatio" | "reviewSidebarWidth";

function resizeHandleAttributes(options: {
	axis: "horizontal" | "vertical";
	defaultValue: number;
	maximum: number;
	minimum: number;
	preference: ResizePreference;
	scale: string;
}) {
	const coordinate = options.axis === "horizontal" ? "clientX" : "clientY";
	const decrease = options.axis === "horizontal" ? "ArrowLeft" : "ArrowUp";
	const increase = options.axis === "horizontal" ? "ArrowRight" : "ArrowDown";
	const value = `$workspaceReviewPreferences.${options.preference}`;
	const normalize = `${value} = Math.min(
		${options.maximum},
		Math.max(${options.minimum}, ${value} || ${options.defaultValue}),
	);`;
	const commit = `document.body.dispatchEvent(new CustomEvent(
		'pi-ui-workspace-review-preferences',
		{ detail: { ${options.preference}: ${value} } },
	));`;
	const finish = `if (el.hasPointerCapture(evt.pointerId)) {
		${normalize}
		document.documentElement.classList.remove('is-resizing');
		${commit}
	}`;
	return {
		"data-on:pointerdown": `if (evt.button === 0) {
			el.dataset.resizePointer = evt.${coordinate};
			el.dataset.resizeScale = ${options.scale};
			el.dataset.resizeStart = ${value} || ${options.defaultValue};
			el.setPointerCapture(evt.pointerId);
			document.documentElement.classList.add('is-resizing');
		}`,
		"data-on:pointermove__throttle.8ms": `if (el.hasPointerCapture(evt.pointerId)) {
			${value} = Number(el.dataset.resizeStart) +
				(evt.${coordinate} - Number(el.dataset.resizePointer)) /
				Number(el.dataset.resizeScale);
		}`,
		"data-on:pointerup": finish,
		"data-on:pointercancel": finish,
		"data-on:dblclick": `${value} = ${options.defaultValue}; ${commit}`,
		"data-on:keydown": `if (evt.code === '${decrease}' || evt.code === '${increase}') {
			evt.preventDefault();
			const direction = evt.code === '${decrease}' ? -1 : 1;
			${value} = (${value} || ${options.defaultValue}) +
				direction * (evt.shiftKey ? 48 : 16) / (${options.scale});
			${normalize}
			${commit}
		}`,
	};
}

export function renderWorkspaceReview(
	workspacePath: string,
	filesRevision: number,
	treeRevision: number,
	snapshot: WorkspaceReviewSnapshot,
	preferences: WorkspaceReviewPreferences,
	gitGraph: WorkspaceGitGraphSnapshot,
): string {
	return syncHtml(
		<section
			id="workspace-review"

			aria-label="Workspace"
			aria-keyshortcuts={keybindAria(
				"focus-workspace-editor",
				"focus-workspace-files",
				"focus-workspace-changes",
			)}
			aria-hidden="true"
			inert
			data-on:keydown__window={keybindActions(
				["focus-workspace-files", "window.piUi.workspaceReview.focusFiles();"],
				["focus-workspace-changes", "window.piUi.workspaceReview.focusGit();"],
				["focus-workspace-editor", "window.piUi.workspaceReview.focusEditor();"],
			)}
			data-attr:aria-hidden="$_workspaceReviewOpen ? 'false' : 'true'"
			data-attr:inert="!$_workspaceReviewOpen"
		>
			<div
				id="review-body"
				class="review-body"
				data-review-tab={
					snapshot.isGitRepository && preferences.tab !== "files"
						? "git"
						: "files"
				}
				data-attr:data-review-tab="$_workspaceReviewGitAvailable && $workspaceReviewPreferences.tab !== 'files' ? 'git' : 'files'"
				data-style={`{
					'--review-sidebar-width': ($workspaceReviewPreferences.reviewSidebarWidth || ${reviewSidebarWidthDefault}) + 'px',
				}`}
			>
				<aside
					id="workspace-files-sidebar"
					class="review-sidebar"
					style={
						snapshot.isGitRepository && preferences.tab !== "files"
							? "display: none"
							: undefined
					}
					data-show="!$_workspaceReviewGitAvailable || $workspaceReviewPreferences.tab === 'files'"
				>
					{renderWorkspaceModeHeader("files", snapshot.isGitRepository)}
					<section class="raised-surface review-sidebar-panel">
						<div
							id="workspace-file-tree"
							class="review-tree"
							aria-label="Workspace files"
							tabindex="-1"
						/>
					</section>
				</aside>

				<aside
					id="review-git-sidebar"
					class="review-sidebar"
					style={
						!snapshot.isGitRepository || preferences.tab === "files"
							? "display: none"
							: undefined
					}
					data-show="
						$_workspaceReviewGitAvailable &&
						$workspaceReviewPreferences.tab !== 'files'
					"
				>
					{renderWorkspaceModeHeader("git", snapshot.isGitRepository)}
					<section class="raised-surface review-sidebar-panel review-changes">
						<header
							id="review-changes-summary"
							class="review-sidebar-header"
							hidden={gitGraph.changeCount === 0}
							data-attr:hidden="$_workspaceReviewChangeCount === 0"
						>
							<span>Uncommitted changes</span>
							<span
								id="review-change-count"
								title="Changed files and untracked folders"
								class="fine-print review-change-count"
								data-text="$_workspaceReviewChangeCount"
							>
								{gitGraph.changeCount}
							</span>
						</header>
						<div
							id="review-changes-clean"
							class="review-tree-empty"
							style={gitGraph.changeCount > 0 ? "display: none" : undefined}
							data-show="$_workspaceReviewChangeCount === 0"
						>
							Working tree clean
						</div>
					</section>
				</aside>

				<div
					id="review-sidebar-separator"
					class="resize-handle"
					role="separator"
					tabindex="0"
					aria-label="Resize file sidebar"
					aria-orientation="vertical"
					aria-valuemin={reviewSidebarWidthMin}
					aria-valuemax={reviewSidebarWidthMax}
					data-attr:aria-valuenow={`$workspaceReviewPreferences.reviewSidebarWidth || ${reviewSidebarWidthDefault}`}
					attrs={resizeHandleAttributes({
						axis: "horizontal",
						defaultValue: reviewSidebarWidthDefault,
						maximum: reviewSidebarWidthMax,
						minimum: reviewSidebarWidthMin,
						preference: "reviewSidebarWidth",
						scale: "1",
					})}
				/>

				<div
					id="workspace-file-main"
					class="review-main"
					aria-label="File editor"
					aria-keyshortcuts={keybindAria("focus-workspace-editor")}
					tabindex="-1"
					style={
						snapshot.isGitRepository && preferences.tab !== "files"
							? "display: none"
							: undefined
					}
					data-show="!$_workspaceReviewGitAvailable || $workspaceReviewPreferences.tab === 'files'"
				>
					<header class="review-toolbar">
						<div class="review-file-heading">
							<span
								id="workspace-file-path"
								class="fine-print review-file-path"
							>
								Select a file
							</span>
							<span
								id="workspace-file-status"
								class="fine-print review-file-status"
							/>
						</div>
						<div class="review-toolbar-controls">
							<ShortcutKbd
								shortcut={activeKeybind("focus-workspace-editor")}
							/>
							<div
								id="workspace-file-mode"
								class="segmented-control"
								aria-label="File view"
								hidden
							>
								<button
									id="workspace-file-preview-mode"
									type="button"
									class="review-segment-text"
									aria-pressed="true"
								>
									Preview
								</button>
								<button
									id="workspace-file-source-mode"
									type="button"
									class="review-segment-text"
									aria-pressed="false"
								>
									Source
								</button>
							</div>
							<div
								id="workspace-file-wrap-control"
								class="segmented-control review-icon-control"
							>
								<button
									id="workspace-file-wrap"
									type="button"
									class="review-segment-icon"
									aria-pressed="true"
									aria-label="Wrap long lines"
								>
									<Icon icon={TextWrap} />
								</button>
							</div>
							<button
								id="workspace-file-download"
								type="button"
								class="btn"
								data-variant="outline"
								data-size="xs"
								title="Download the saved file"
								disabled
							>
								Download
							</button>
							<button
								id="workspace-file-edit"
								type="button"
								class="btn"
								data-variant="outline"
								data-size="xs"
								disabled
							>
								Save
							</button>
							<button
								type="button"
								class="btn review-close"
								data-variant="ghost"
								data-size="icon-xs"
								data-on:click="$_workspaceReviewOpen = false"
								aria-label="Hide workspace"
							>
								<Icon icon={X} />
							</button>
						</div>
					</header>
					<div class="review-diff-canvas">
						<div
							id="workspace-file-view"
							class="review-scroll-view"
							aria-label="File source"
							aria-keyshortcuts={keybindAria("focus-workspace-editor")}
							tabindex="-1"
						/>
						<div
							id="workspace-file-preview"
							class="workspace-file-preview"
							aria-label="File preview"
							tabindex="-1"
							hidden
						/>
						<div id="workspace-file-empty" class="review-empty">
							Open a file from the workspace
						</div>
					</div>
				</div>

				<div
					id="review-git-main"
					class="review-main"
					style={
						!snapshot.isGitRepository || preferences.tab === "files"
							? "display: none"
							: undefined
					}
					data-show="$_workspaceReviewGitAvailable && $workspaceReviewPreferences.tab !== 'files'"
				>
					<header class="review-toolbar">
						<span
							id="review-branch"
							class="fine-print review-branch"
							hidden={!snapshot.branch}
							data-attr:hidden="!Boolean($_workspaceReviewBranch)"
							data-text="$_workspaceReviewBranch"
							safe
						>
							{snapshot.branch ?? ""}
						</span>
						<div class="review-toolbar-controls">
							<ShortcutKbd
								shortcut={activeKeybind("focus-workspace-editor")}
							/>
							<button
								id="review-graph-more"
								type="button"
								class="btn"
								data-variant="outline"
								data-size="xs"
								hidden={!gitGraph.hasMore}
							>
								Load more
							</button>
							<button
								type="button"
								class="btn review-close"
								data-variant="ghost"
								data-size="icon-xs"
								data-on:click="$_workspaceReviewOpen = false"
								aria-label="Hide workspace"
							>
								<Icon icon={X} />
							</button>
						</div>
					</header>
					<div class="review-diff-canvas">
						<div
							id="review-graph"
							class="review-scroll-view review-graph"
							aria-label="Commit graph"
							aria-keyshortcuts={keybindAria("focus-workspace-editor")}
							tabindex="-1"
						/>
						<aside
							id="review-detail-header"
							class="review-graph-detail"
							aria-label="Commit detail"
							hidden
						/>
						<div id="review-empty" class="review-empty">
							{snapshot.isGitRepository
								? "Loading Git data…"
								: "Open a Git repository"}
						</div>
					</div>
				</div>
			</div>
			<div
				id="review-git-separator"
				class="resize-handle"
				role="separator"
				tabindex="0"
				aria-label="Resize Git and chat"
				aria-orientation="vertical"
				aria-valuemin={gitPaneRatioMin * 100}
				aria-valuemax={gitPaneRatioMax * 100}
				data-attr:aria-valuenow={`Math.round(($workspaceReviewPreferences.gitPaneRatio || ${gitPaneRatioDefault}) * 100)`}
				attrs={resizeHandleAttributes({
					axis: "horizontal",
					defaultValue: gitPaneRatioDefault,
					maximum: gitPaneRatioMax,
					minimum: gitPaneRatioMin,
					preference: "gitPaneRatio",
					scale: "Math.max(1, document.getElementById('workspace-shell').clientWidth - 12)",
				})}
			/>
			{renderWorkspaceReviewDataRegion(
				workspacePath,
				filesRevision,
				treeRevision,
				snapshot,
				preferences,
				gitGraph,
			)}
			<dialog
				id="workspace-entry-dialog"
				class="dialog"
				aria-labelledby="workspace-entry-title"
				aria-describedby="workspace-entry-description"
			>
				<div class="dialog-medium">
					<header>
						<h2 id="workspace-entry-title">Name item</h2>
						<p id="workspace-entry-description" />
					</header>
					<section>
						<label class="sr-only" for="workspace-entry-input">
							Name
						</label>
						<input
							id="workspace-entry-input"
							class="input"
							type="text"
							autocomplete="off"
							autocorrect="off"
							spellcheck="false"
						/>
						<p
							id="workspace-entry-error"
							class="workspace-entry-error"
							hidden
							aria-live="polite"
						/>
					</section>
					<footer>
						<button
							type="button"
							class="btn"
							data-variant="outline"
							commandfor="workspace-entry-dialog"
							command="close"
						>
							Cancel
						</button>
						<button id="workspace-entry-action" type="button" class="btn">
							Save
						</button>
					</footer>
				</div>
			</dialog>
			<dialog
				id="workspace-confirm-dialog"
				class="alert-dialog"
				data-size="sm"
				aria-labelledby="workspace-confirm-title"
				aria-describedby="workspace-confirm-description"
			>
				<div>
					<header>
						<h2 id="workspace-confirm-title">Confirm action</h2>
						<p id="workspace-confirm-description" />
					</header>
					<form method="dialog">
						<button
							id="workspace-confirm-cancel"
							type="submit"
							class="btn"
							data-variant="outline"
							value="cancel"
						>
							Cancel
						</button>
						<button
							id="workspace-confirm-action"
							type="submit"
							class="btn"
							data-variant="destructive"
							value="confirm"
						>
							Continue
						</button>
					</form>
				</div>
			</dialog>
		</section>,
	);
}

function renderWorkspaceModeHeader(
	active: "files" | "git",
	gitAvailable: boolean,
): JSX.Element {
	return (
		<header
			class="workspace-mode-header"
			style={gitAvailable ? undefined : "display: none"}
			data-show="$_workspaceReviewGitAvailable"
		>
			<div
				class="segmented-control workspace-mode-control"
				aria-label="Workspace view"
			>
				<button
					type="button"
					class="workspace-mode-button"
					aria-pressed={active === "files" ? "true" : "false"}
					data-attr:aria-pressed="
						$workspaceReviewPreferences.tab === 'files' ||
						!$_workspaceReviewGitAvailable ? 'true' : 'false'
					"
					data-workspace-mode="files"
					aria-keyshortcuts={keybindAria("focus-workspace-files")}
				>
					<span>Files</span>
					<ShortcutKbd shortcut={activeKeybind("focus-workspace-files")} />
				</button>
				<button
					type="button"
					class="workspace-mode-button"
					aria-pressed={active === "git" ? "true" : "false"}
					data-attr:aria-pressed="
						$workspaceReviewPreferences.tab !== 'files' &&
						$_workspaceReviewGitAvailable ? 'true' : 'false'
					"
					data-workspace-mode="git"
					disabled={!gitAvailable}
					data-attr:disabled="!$_workspaceReviewGitAvailable"
					aria-keyshortcuts={keybindAria("focus-workspace-changes")}
				>
					<span>Git</span>
					<ShortcutKbd shortcut={activeKeybind("focus-workspace-changes")} />
				</button>
			</div>
		</header>
	);
}

function workspaceReviewDataElement(
	workspacePath: string,
	filesRevision: number,
	treeRevision: number,
	snapshot: WorkspaceReviewSnapshot,
	preferences: WorkspaceReviewPreferences,
	gitGraph: WorkspaceGitGraphSnapshot,
): JSX.Element {
	return (
		<script id="workspace-review-data" type="application/json">
			{JSON.stringify({
				filesRevision,
				treeRevision,
				preferences,
				snapshot,
				gitGraph,
				workspacePath,
			}).replaceAll("<", "\\u003c")}
		</script>
	);
}

function renderWorkspaceReviewDataRegion(
	workspacePath: string,
	filesRevision: number,
	treeRevision: number,
	snapshot: WorkspaceReviewSnapshot,
	preferences: WorkspaceReviewPreferences,
	gitGraph: WorkspaceGitGraphSnapshot,
): JSX.Element {
	return (
		<div id="workspace-review-data-region" hidden>
			{workspaceReviewDataElement(
				workspacePath,
				filesRevision,
				treeRevision,
				snapshot,
				preferences,
				gitGraph,
			)}
		</div>
	);
}

export function renderWorkspaceReviewData(
	workspacePath: string,
	filesRevision: number,
	treeRevision: number,
	snapshot: WorkspaceReviewSnapshot,
	preferences: WorkspaceReviewPreferences,
	gitGraph: WorkspaceGitGraphSnapshot,
): string {
	return syncHtml(
		workspaceReviewDataElement(
			workspacePath,
			filesRevision,
			treeRevision,
			snapshot,
			preferences,
			gitGraph,
		),
	);
}
