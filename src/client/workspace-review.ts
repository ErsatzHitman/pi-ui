import { isPierreThemes, setActiveCodeTheme } from "../pierre-theme.ts";
import { isNumber, isRecord, isString } from "../utils/type-guards.ts";
import {
	isWorkspaceGitGraphSnapshot,
	unloadedWorkspaceGitGraphSnapshot,
	type WorkspaceGitGraphSnapshot,
} from "../workspace-git-graph-types.ts";
import {
	isWorkspaceReviewSnapshot,
	normalizeWorkspaceReviewPreferences,
	type WorkspaceReviewPreferences,
	type WorkspaceReviewSnapshot,
} from "../workspace-review-types.ts";
import { requiredButton, requiredElement } from "./dom.ts";
import { createWorkspaceFiles } from "./workspace-files.ts";
import { createWorkspaceGitGraphApi } from "./workspace-git-graph-api.ts";
import { createWorkspaceGitGraph } from "./workspace-git-graph.ts";

const codeThemeLight = document.body.dataset.codeThemeLight;
const codeThemeDark = document.body.dataset.codeThemeDark;
if (codeThemeLight && codeThemeDark) {
	setActiveCodeTheme({ dark: codeThemeDark, light: codeThemeLight });
}
const endpoint = document.body.dataset.workspaceReviewEndpoint ?? "";
const filesEndpoint = document.body.dataset.workspaceFilesEndpoint ?? "";
const graphApi = createWorkspaceGitGraphApi(endpoint);

// `setActiveCodeTheme()` backs `getPierreThemes()`, which the Files tab's own
// source and preview highlighting reads (`workspace-files.ts`); this module
// is the one place that keeps that shared theme state initialized and current.
window.addEventListener("pi-ui-code-theme-changed", (event) => {
	if (!(event instanceof CustomEvent) || !isPierreThemes(event.detail)) return;
	setActiveCodeTheme(event.detail);
});

const app = requiredElement("app");
const modeButtons = document.querySelectorAll<HTMLButtonElement>("[data-workspace-mode]");
const fileTreeHost = requiredElement("workspace-file-tree");
const fileViewRoot = requiredElement("workspace-file-view");
const graphHost = requiredElement("review-graph");
const branchesHost = requiredElement("review-branch-list");
const graphDetail = requiredElement("review-detail-header");
const graphEmpty = requiredElement("review-empty");
const graphMoreButton = requiredButton("review-graph-more");
const workspaceReviewRoot = requiredElement("workspace-review");
const dataRegion = requiredElement("workspace-review-data-region");
const data = requiredElement("workspace-review-data");

const initialData = JSON.parse(data.textContent ?? "");
if (
	!isRecord(initialData) ||
	!isNumber(initialData.filesRevision) ||
	!isNumber(initialData.treeRevision) ||
	!isString(initialData.workspacePath) ||
	!isWorkspaceReviewSnapshot(initialData.snapshot)
) {
	throw new Error("Invalid initial workspace review state");
}
const preferences = normalizeWorkspaceReviewPreferences(initialData.preferences);
let workspacePath = initialData.workspacePath;
let filesRevision = initialData.filesRevision;
let treeRevision = initialData.treeRevision;
let snapshot: WorkspaceReviewSnapshot = initialData.snapshot;
let gitGraph: WorkspaceGitGraphSnapshot = isWorkspaceGitGraphSnapshot(
	initialData.gitGraph,
)
	? initialData.gitGraph
	: unloadedWorkspaceGitGraphSnapshot;

const gitGraphController = createWorkspaceGitGraph({
	api: graphApi,
	branchesHost,
	detail: graphDetail,
	empty: graphEmpty,
	moreButton: graphMoreButton,
	rowsHost: graphHost,
});

const workspaceFiles = createWorkspaceFiles({
	endpoint: filesEndpoint,
	initialGitStatus: snapshot.changes,
	initialWorkspacePath: workspacePath,
});
let preferredPanelMode: "files" | "git" | undefined = preferences.tab;
let panelMode = initialPanelMode(preferredPanelMode, snapshot.isGitRepository);

const visibility = createVisibility(app, true, (open) => {
	workspaceFiles.setVisible(open && panelMode === "files");
});
for (const button of modeButtons) {
	button.addEventListener("click", () => {
		const mode = button.dataset.workspaceMode;
		if (mode === "files" || (mode === "git" && snapshot.isGitRepository)) {
			setPanelMode(mode);
		}
	});
}

bindWorkspaceKeyboardNavigation();
window.piUi.workspaceReview = {
	...visibility,
	focusEditor,
	focusFiles,
	focusGit,
};

function applyWorkspaceReviewData(): void {
	try {
		const currentData = document.getElementById("workspace-review-data");
		const value = JSON.parse(currentData?.textContent ?? "");
		if (
			isRecord(value) &&
			isNumber(value.filesRevision) &&
			isNumber(value.treeRevision) &&
			isString(value.workspacePath) &&
			isWorkspaceReviewSnapshot(value.snapshot)
		) {
			const filesChanged =
				value.workspacePath === workspacePath &&
				value.filesRevision !== filesRevision;
			const treeChanged = value.treeRevision !== treeRevision;
			filesRevision = value.filesRevision;
			treeRevision = value.treeRevision;
			applyWorkspaceReview(value.workspacePath, value.snapshot);
			if (filesChanged) workspaceFiles.refresh(treeChanged);
			if (isWorkspaceGitGraphSnapshot(value.gitGraph)) {
				gitGraph = value.gitGraph;
				gitGraphController.applySnapshot(gitGraph);
			}
		}
	} catch {
		// A later stream morph can replace an incomplete payload.
	}
}

const reviewData = new MutationObserver(applyWorkspaceReviewData);
reviewData.observe(dataRegion, {
	characterData: true,
	childList: true,
	subtree: true,
});

applySnapshot(snapshot);
gitGraphController.applySnapshot(gitGraph);
applyWorkspaceReviewData();

window.addEventListener(
	"pagehide",
	() => {
		reviewData.disconnect();
		workspaceFiles.cleanUp();
		gitGraphController.dispose();
	},
	{ once: true },
);

function applyWorkspaceReview(
	nextWorkspacePath: string,
	next: WorkspaceReviewSnapshot,
): void {
	if (snapshot.revision === next.revision && workspacePath === nextWorkspacePath)
		return;
	const workspaceChanged = nextWorkspacePath !== workspacePath;
	if (workspaceChanged) {
		workspacePath = nextWorkspacePath;
		workspaceFiles.setWorkspace(workspacePath);
	}
	applySnapshot(next);
}

function applySnapshot(next: WorkspaceReviewSnapshot): void {
	const gitWasAvailable = snapshot.isGitRepository;
	snapshot = next;
	workspaceFiles.setGitStatus(snapshot.changes);
	if (!snapshot.isGitRepository) panelMode = "files";
	else if (!gitWasAvailable && preferredPanelMode !== "files") panelMode = "git";
	workspaceFiles.setVisible(visibility.isOpen() && panelMode === "files");
}

function initialPanelMode(
	preferred: WorkspaceReviewPreferences["tab"],
	gitAvailable: boolean,
): "files" | "git" {
	return gitAvailable && preferred !== "files" ? "git" : "files";
}

function setPanelMode(next: "files" | "git"): void {
	if (next === panelMode || (next === "git" && !snapshot.isGitRepository)) return;
	panelMode = next;
	preferredPanelMode = next;
	writePreferences();
	if (!visibility.isOpen()) return;
	workspaceFiles.setVisible(next === "files");
}

export async function openLinkedWorkspaceFile(
	path: string,
	linkedWorkspacePath: string,
): Promise<void> {
	if (linkedWorkspacePath !== workspacePath)
		throw new Error("The workspace changed. Open the file link again.");
	visibility.open();
	setPanelMode("files");
	await workspaceFiles.openFile(path);
	focusAfterOpen(() => workspaceFiles.focusEditor());
}

/**
 * Reveals a linked directory in the Files view (used in remote mode, where
 * there is no host desktop to open a folder on). When the directory isn't
 * part of this workspace's tree, shows a native pi-ui notice dialog (the same
 * one used elsewhere in this module) rather than telling the caller to fall
 * back to a browser `alert()`.
 */
export async function openLinkedWorkspaceDirectory(
	path: string,
	linkedWorkspacePath: string,
): Promise<void> {
	if (linkedWorkspacePath !== workspacePath)
		throw new Error("The workspace changed. Open the file link again.");
	visibility.open();
	setPanelMode("files");
	const revealed = await workspaceFiles.revealPath(path);
	if (!revealed) {
		await workspaceFiles.requestNotice(
			"Folder is outside the workspace",
			`This folder can't be shown here because it's outside the workspace: ${path}`,
		);
	}
}

function focusFiles(): void {
	visibility.open();
	setPanelMode("files");
	focusAfterOpen(() => workspaceFiles.focusTree());
}

function focusGit(): void {
	if (!snapshot.isGitRepository) return;
	visibility.open();
	setPanelMode("git");
	focusAfterOpen(() => gitGraphController.focusSelected());
}

function focusEditor(): void {
	visibility.open();
	focusAfterOpen(() => {
		if (panelMode === "files") workspaceFiles.focusEditor();
		else graphHost.focus({ preventScroll: true });
	});
}

function focusAfterOpen(focus: () => void): void {
	requestAnimationFrame(() => requestAnimationFrame(focus));
}

function bindWorkspaceKeyboardNavigation(): void {
	workspaceReviewRoot.addEventListener("keydown", (event) => {
		if (
			event.defaultPrevented ||
			event.isComposing ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			(event.code !== "KeyJ" && event.code !== "KeyK")
		) {
			return;
		}
		const path = event.composedPath();
		if (path.some(isTextInput)) return;
		const arrow = event.code === "KeyJ" ? "ArrowDown" : "ArrowUp";

		if (path.includes(graphHost)) {
			event.preventDefault();
			path[0]?.dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					code: arrow,
					key: arrow,
				}),
			);
			return;
		}

		if (path.includes(fileTreeHost)) {
			event.preventDefault();
			path[0]?.dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					code: arrow,
					composed: true,
					key: arrow,
				}),
			);
			return;
		}

		if (!path.includes(fileViewRoot)) return;
		event.preventDefault();
		fileViewRoot.scrollBy({
			behavior: "smooth",
			top: event.code === "KeyJ" ? 100 : -100,
		});
	});
}

function isTextInput(target: EventTarget | undefined): boolean {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	);
}

function createVisibility(
	app: HTMLElement,
	initiallyAvailable: boolean,
	onChange: (open: boolean) => void,
) {
	let available = initiallyAvailable;
	let open = false;
	const syncAvailability = () => {
		const button = document.querySelector<HTMLElement>(
			'[data-pi-ui-action="review"]',
		);
		if (!button) return;
		button.inert = !available;
	};
	const requestOpen = (next: boolean) => {
		app.dispatchEvent(
			new CustomEvent("pi-ui-workspace-review-open", {
				detail: { open: available && next },
			}),
		);
	};
	const applyOpen = (next: boolean) => {
		if (next && !available) {
			requestOpen(false);
			return;
		}
		const wasOpen = open;
		open = next;
		if (open !== wasOpen) onChange(open);
	};
	syncAvailability();
	applyOpen(app.classList.contains("review-open"));
	return {
		applyOpen,
		isAvailable: () => available,
		isOpen: () => open,
		open: () => requestOpen(true),
		setAvailable(next: boolean) {
			available = next;
			syncAvailability();
			if (!available) requestOpen(false);
		},
	};
}

function writePreferences(): void {
	writeWorkspaceReviewPreferences({ tab: preferredPanelMode });
}

function writeWorkspaceReviewPreferences(value: WorkspaceReviewPreferences): void {
	document.body.dispatchEvent(
		new CustomEvent("pi-ui-workspace-review-preferences", { detail: value }),
	);
}
