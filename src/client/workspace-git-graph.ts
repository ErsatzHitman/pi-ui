import {
	formatAdaptiveDateTime,
	formatExpandedDateTime,
} from "../utils/date-time-format.ts";
import {
	type GitGraphRef,
	type GitGraphRow,
	unloadedWorkspaceGitGraphSnapshot,
	type WorkspaceGitGraphCommitDetail,
	workspaceGitGraphPageSize,
	type WorkspaceGitGraphSnapshot,
} from "../workspace-git-graph-types.ts";
import type { createWorkspaceGitGraphApi } from "./workspace-git-graph-api.ts";

const unloadedRevision = unloadedWorkspaceGitGraphSnapshot.revision;
const maxLaneGap = 16;
const laneInset = 8;
const rowHeight = 28;
const dotRadius = 3.5;
const lanePaletteSize = 8; // Matches the `--graph-lane-N` tokens; lanes beyond this cycle.
// The graph area's rendered width is capped regardless of how many concurrent
// branches (lanes) a repo has, so a busy history (or a narrow 390px pane)
// never squeezes the commit subject out entirely — lanes just pack tighter.
const maxLaneAreaWidth = 120;
// Matches the CSS `@media (width <= 30rem)` breakpoint (workspace-review.css)
// that hides the hash/author/time columns — below it, a row has only the
// lane, subject, and ref badges left to fit, so refs collapse harder too.
const narrowRowWidth = 480;

function renderRefBadge(ref: GitGraphRef): HTMLElement {
	const badge = document.createElement("span");
	// Reuses the shared `.badge` primitive (pill shape, base colors) and layers
	// `.review-graph-ref` on top for the denser sizing a commit row needs.
	badge.className = "badge review-graph-ref";
	badge.dataset.kind = ref.kind;
	if (ref.main) badge.dataset.main = "";
	if (ref.current) badge.dataset.current = "";
	// Flexbox doesn't run `text-overflow: ellipsis` on a bare text node inside
	// a flex container (the badge itself is `display: inline-flex`, from
	// `.badge`) — it just hard-clips, cutting a ref name mid-word with no "…".
	// A nested, non-flex label carries the truncation instead, and needs its
	// own `min-width: 0` since it is now the badge's sole flex item.
	const label = document.createElement("span");
	label.className = "review-graph-ref-label";
	label.textContent = ref.name;
	badge.append(label);
	return badge;
}

/** Lower sorts first: the current branch and main lead, tags trail. */
function refPriority(ref: GitGraphRef): number {
	if (ref.current) return 0;
	if (ref.main) return 1;
	if (ref.kind === "local-branch") return 2;
	if (ref.kind === "remote-branch") return 3;
	if (ref.kind === "head") return 4;
	return 5;
}

type WorkspaceGitGraphOptions = Readonly<{
	api: ReturnType<typeof createWorkspaceGitGraphApi>;
	detail: HTMLElement;
	empty: HTMLElement;
	moreButton: HTMLButtonElement;
	rowsHost: HTMLElement;
}>;

export type WorkspaceGitGraphController = Readonly<{
	applySnapshot(snapshot: WorkspaceGitGraphSnapshot): void;
	dispose(): void;
	focusSelected(): void;
}>;

export function createWorkspaceGitGraph(
	options: WorkspaceGitGraphOptions,
): WorkspaceGitGraphController {
	const { api, detail, empty, moreButton, rowsHost } = options;
	let snapshot: WorkspaceGitGraphSnapshot | undefined;
	let selectedHash: string | undefined;
	let detailOpen = false;
	const detailCache = new Map<string, WorkspaceGitGraphCommitDetail>();
	let detailRequest = 0;
	// Rows "Load more" asked for. Live refreshes (the workspace watcher, e.g. every file
	// an agent writes) publish the default-sized window; while this is set they are
	// re-read at this size instead, so the extra history (and the scroll position in it)
	// is not dropped on the next change.
	let expandedCount: number | undefined;
	let expandedRequest: Promise<void> | undefined;
	let expandedStale = false;

	rowsHost.addEventListener("keydown", handleKeydown);
	moreButton.addEventListener("click", () => void loadMore());

	// The lane area's width budget depends on `rowsHost.clientWidth` (see
	// `laneGap`), so a live resize (the review pane's own splitters, or the
	// window) must re-render, not just a fresh snapshot.
	let resizeFrame: number | undefined;
	const resize = new ResizeObserver(() => {
		if (resizeFrame !== undefined) return;
		resizeFrame = requestAnimationFrame(() => {
			resizeFrame = undefined;
			render();
		});
	});
	resize.observe(rowsHost);

	function applySnapshot(next: WorkspaceGitGraphSnapshot): void {
		if (!next.isGitRepository || next.revision === unloadedRevision) {
			expandedCount = undefined;
		}
		if (
			expandedCount !== undefined &&
			next.hasMore &&
			next.rows.length < expandedCount
		) {
			void refreshExpanded();
			return;
		}
		show(next);
	}

	async function refreshExpanded(): Promise<void> {
		if (expandedRequest) {
			expandedStale = true;
			return expandedRequest;
		}
		expandedRequest = (async () => {
			do {
				expandedStale = false;
				const count = expandedCount;
				if (count === undefined) return;
				try {
					show(await api.loadMore(count));
				} catch {
					// Keep the rows already shown; the next refresh retries.
				}
			} while (expandedStale);
		})();
		try {
			await expandedRequest;
		} finally {
			expandedRequest = undefined;
		}
	}

	function show(next: WorkspaceGitGraphSnapshot): void {
		if (snapshot?.revision === next.revision) return;
		snapshot = next;
		if (selectedHash && !next.rows.some((row) => row.hash === selectedHash)) {
			selectedHash = undefined;
			closeDetail();
		}
		render();
	}

	function render(): void {
		if (!snapshot) return;
		const changeCount = snapshot.changeCount;
		const scrollTop = rowsHost.scrollTop;
		// Rows are rebuilt on every refresh and resize; keep keyboard focus on the same
		// commit so arrow-key browsing survives a live update.
		const focusedHash =
			document.activeElement instanceof HTMLElement &&
			rowsHost.contains(document.activeElement)
				? document.activeElement.dataset.hash
				: undefined;
		rowsHost.replaceChildren();
		if (changeCount > 0) rowsHost.append(renderWorkingRow(changeCount));
		if (snapshot.rows.length === 0 && changeCount === 0) {
			empty.hidden = false;
			empty.textContent =
				snapshot.revision === unloadedRevision
					? "Loading Git data…"
					: snapshot.isGitRepository
						? "No commits yet"
						: "Open a Git repository";
		} else {
			empty.hidden = true;
			for (const row of snapshot.rows) rowsHost.append(renderRow(row));
		}
		rowsHost.scrollTop = scrollTop;
		if (focusedHash) {
			rowButtons()
				.find((button) => button.dataset.hash === focusedHash)
				?.focus({ preventScroll: true });
		}
		moreButton.hidden = !snapshot.hasMore;
	}

	/** Fewer ref badges fit before a "+N" overflow badge at a narrower width. */
	function maxVisibleRefsForWidth(): number {
		const available = rowsHost.clientWidth || narrowRowWidth;
		return available <= narrowRowWidth ? 1 : 3;
	}

	function laneGap(): number {
		const lanes = (snapshot?.laneCount ?? 1) + 1;
		// The lane area may take a share of the row's *actual* rendered width
		// (not just a fixed cap), so it also compresses when the pane itself is
		// narrow — a 390px pane and a busy multi-branch history can both push
		// against the same budget at once.
		const available = rowsHost.clientWidth || maxLaneAreaWidth;
		const budget = Math.min(maxLaneAreaWidth, Math.max(40, available * 0.25));
		return Math.min(maxLaneGap, budget / lanes);
	}

	function renderWorkingRow(changeCount: number): HTMLElement {
		const row = document.createElement("div");
		row.className = "review-graph-row review-graph-working";
		const lane = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		lane.setAttribute("class", "review-graph-lane");
		lane.setAttribute("viewBox", `0 0 ${maxLaneGap} ${rowHeight}`);
		lane.style.width = `${maxLaneGap}px`;
		lane.setAttribute("aria-hidden", "true");
		const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		dot.setAttribute("cx", String(laneInset));
		dot.setAttribute("cy", String(rowHeight / 2));
		dot.setAttribute("r", String(dotRadius));
		dot.setAttribute("class", "review-graph-dot review-graph-dot-working");
		lane.append(dot);
		const subject = document.createElement("span");
		subject.className = "review-graph-subject";
		subject.textContent = `${changeCount} uncommitted change${changeCount === 1 ? "" : "s"}`;
		row.append(lane, subject);
		return row;
	}

	function renderRow(row: GitGraphRow): HTMLElement {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "review-graph-row";
		button.dataset.hash = row.hash;
		button.setAttribute(
			"aria-pressed",
			String(row.hash === selectedHash && detailOpen),
		);
		button.title = row.subject || "Untitled commit";
		button.addEventListener("click", () => void toggleSelection(row.hash));

		button.append(renderLane(row));

		const subject = document.createElement("span");
		subject.className = "review-graph-subject";
		subject.textContent = row.subject || "Untitled commit";
		button.append(subject);

		// A commit can carry many refs at once (several local branches sharing a
		// tip, plus remotes and tags). Showing them all crowds out the subject
		// text entirely, so the most identifying ones (current branch, main)
		// sort first and the rest collapse into a "+N" badge — harder at a
		// narrow width, where the row has less room per badge to begin with.
		const maxVisibleRefs = maxVisibleRefsForWidth();
		const sortedRefs = [...row.refs].sort((a, b) => refPriority(a) - refPriority(b));
		for (const ref of sortedRefs.slice(0, maxVisibleRefs)) {
			button.append(renderRefBadge(ref));
		}
		const hiddenRefs = sortedRefs.slice(maxVisibleRefs);
		if (hiddenRefs.length > 0) {
			const more = document.createElement("span");
			more.className = "badge review-graph-ref";
			more.title = hiddenRefs.map((ref) => ref.name).join(", ");
			more.textContent = `+${hiddenRefs.length}`;
			button.append(more);
		}

		const hash = document.createElement("span");
		hash.className = "review-graph-hash fine-print";
		hash.textContent = row.shortHash;
		button.append(hash);

		const author = document.createElement("span");
		author.className = "review-graph-author fine-print";
		author.textContent = row.author;
		button.append(author);

		const time = document.createElement("time");
		time.className = "review-graph-time formatted-date fine-print";
		time.dateTime = row.authoredAt;
		time.title = formatExpandedDateTime(new Date(row.authoredAt));
		time.textContent = formatAdaptiveDateTime(new Date(row.authoredAt));
		button.append(time);

		return button;
	}

	function renderLane(row: GitGraphRow): SVGSVGElement {
		const gap = laneGap();
		const width = gap * ((snapshot?.laneCount ?? 1) + 1);
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("class", "review-graph-lane");
		svg.setAttribute("viewBox", `0 0 ${width} ${rowHeight}`);
		svg.style.width = `${width}px`;
		svg.setAttribute("aria-hidden", "true");
		for (const segment of row.segments) {
			const x1 = laneX(segment.fromLane);
			const x2 = laneX(segment.toLane);
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute(
				"d",
				x1 === x2
					? `M ${x1} 0 L ${x1} ${rowHeight}`
					: `M ${x1} 0 C ${x1} ${rowHeight / 2}, ${x2} ${rowHeight / 2}, ${x2} ${rowHeight}`,
			);
			path.setAttribute("class", "review-graph-segment");
			path.style.setProperty("--lane-color", laneColor(segment.fromLane));
			svg.append(path);
		}
		const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		dot.setAttribute("cx", String(laneX(row.lane)));
		dot.setAttribute("cy", String(rowHeight / 2));
		dot.setAttribute("r", String(dotRadius));
		dot.setAttribute("class", "review-graph-dot");
		dot.style.setProperty("--lane-color", laneColor(row.lane));
		if (row.refs.some((ref) => ref.current))
			dot.classList.add("review-graph-dot-head");
		svg.append(dot);
		return svg;
	}

	function laneX(lane: number): number {
		const gap = laneGap();
		return Math.min(laneInset, gap / 2) + lane * gap;
	}

	function laneColor(lane: number): string {
		return `var(--graph-lane-${lane % lanePaletteSize})`;
	}

	async function toggleSelection(hash: string): Promise<void> {
		if (selectedHash === hash && detailOpen) {
			closeDetail();
			syncPressedState();
			return;
		}
		selectedHash = hash;
		detailOpen = true;
		syncPressedState();
		await showDetail(hash);
	}

	function syncPressedState(): void {
		for (const button of rowButtons()) {
			button.setAttribute(
				"aria-pressed",
				String(button.dataset.hash === selectedHash && detailOpen),
			);
		}
	}

	async function showDetail(hash: string): Promise<void> {
		const cached = detailCache.get(hash);
		if (cached) {
			renderDetail(cached);
			return;
		}
		detail.hidden = false;
		detail.replaceChildren(loadingParagraph("Loading commit…"));
		const requestId = ++detailRequest;
		const loaded = await api.loadCommit(hash);
		if (requestId !== detailRequest || selectedHash !== hash) return;
		if (!loaded) {
			detail.replaceChildren(loadingParagraph("Unable to load commit"));
			return;
		}
		detailCache.set(hash, loaded);
		renderDetail(loaded);
	}

	function renderDetail(value: WorkspaceGitGraphCommitDetail): void {
		detail.hidden = false;
		detail.replaceChildren();
		const heading = document.createElement("div");
		heading.className = "review-detail-heading";
		const subject = document.createElement("div");
		subject.className = "review-detail-subject";
		subject.textContent = value.subject || "Untitled commit";
		heading.append(subject);
		const meta = document.createElement("div");
		meta.className = "fine-print review-detail-meta";
		const hash = document.createElement("span");
		hash.className = "review-detail-hash";
		hash.textContent = value.shortHash;
		const author = document.createElement("span");
		author.className = "review-detail-author";
		author.textContent = value.author;
		const time = document.createElement("time");
		time.className = "formatted-date";
		time.dateTime = value.authoredAt;
		time.textContent = formatExpandedDateTime(new Date(value.authoredAt));
		meta.append(hash, author, time);
		detail.append(heading, meta);

		if (value.body) {
			const body = document.createElement("p");
			body.className = "review-graph-body";
			body.textContent = value.body;
			detail.append(body);
		}

		if (value.parents.length > 0) {
			const parents = document.createElement("div");
			parents.className = "fine-print review-graph-parents";
			parents.append(
				document.createTextNode(
					value.parents.length > 1 ? "Parents " : "Parent ",
				),
			);
			for (const parentHash of value.parents) {
				const known = snapshot?.rows.some((row) => row.hash === parentHash);
				const parentButton = document.createElement("button");
				parentButton.type = "button";
				parentButton.className = "review-graph-parent-link";
				parentButton.textContent = parentHash.slice(0, 7);
				parentButton.disabled = !known;
				parentButton.addEventListener("click", () => {
					const row = rowButtons().find(
						(button) => button.dataset.hash === parentHash,
					);
					row?.scrollIntoView({ block: "center" });
					if (parentHash) void toggleSelection(parentHash);
				});
				parents.append(parentButton);
			}
			detail.append(parents);
		}

		if (value.changes.length > 0) {
			const files = document.createElement("div");
			files.className = "review-commit-files";
			for (const change of value.changes) {
				const row = document.createElement("div");
				row.className = "fine-print review-commit-file";
				const status = document.createElement("span");
				status.className = "review-commit-file-status";
				status.textContent = statusLetter(change.status);
				const path = document.createElement("span");
				path.className = "review-commit-file-path";
				path.textContent = change.path;
				const stats = document.createElement("span");
				stats.className = "review-detail-totals";
				const additions = document.createElement("span");
				additions.className = "review-additions";
				additions.textContent = `+${change.additions}`;
				const deletions = document.createElement("span");
				deletions.className = "review-deletions";
				deletions.textContent = `-${change.deletions}`;
				stats.append(additions, deletions);
				row.append(status, path, stats);
				files.append(row);
			}
			detail.append(files);
		}
	}

	function closeDetail(): void {
		detailOpen = false;
		detail.hidden = true;
		detail.replaceChildren();
	}

	function loadingParagraph(message: string): HTMLElement {
		const paragraph = document.createElement("p");
		paragraph.className = "fine-print review-history-loading";
		paragraph.textContent = message;
		return paragraph;
	}

	function statusLetter(status: "added" | "deleted" | "modified" | "renamed"): string {
		if (status === "added") return "A";
		if (status === "deleted") return "D";
		if (status === "renamed") return "R";
		return "M";
	}

	async function loadMore(): Promise<void> {
		if (!snapshot) return;
		moreButton.disabled = true;
		try {
			expandedCount = snapshot.rows.length + workspaceGitGraphPageSize;
			show(await api.loadMore(expandedCount));
		} finally {
			moreButton.disabled = false;
		}
	}

	function rowButtons(): HTMLButtonElement[] {
		return [
			...rowsHost.querySelectorAll<HTMLButtonElement>(
				".review-graph-row[data-hash]",
			),
		];
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (
			event.defaultPrevented ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey
		) {
			return;
		}
		const buttons = rowButtons();
		if (buttons.length === 0) return;
		const current =
			event.target instanceof HTMLButtonElement
				? buttons.indexOf(event.target)
				: -1;
		if (event.code === "Enter" || event.code === "Space") {
			// Native <button> activation already handles this (click), nothing to add.
			return;
		}
		let index = current;
		if (event.code === "ArrowDown") index = Math.min(current + 1, buttons.length - 1);
		else if (event.code === "ArrowUp")
			index = current < 0 ? buttons.length - 1 : Math.max(0, current - 1);
		else if (event.code === "Home") index = 0;
		else if (event.code === "End") index = buttons.length - 1;
		else return;
		const button = buttons[index];
		if (!button) return;
		event.preventDefault();
		button.focus({ preventScroll: true });
		button.scrollIntoView({ block: "nearest" });
	}

	function focusSelected(): void {
		const button =
			rowsHost.querySelector<HTMLButtonElement>(
				'.review-graph-row[aria-pressed="true"]',
			) ?? rowButtons()[0];
		(button ?? rowsHost).focus({ preventScroll: true });
		button?.scrollIntoView({ block: "nearest" });
	}

	function dispose(): void {
		rowsHost.removeEventListener("keydown", handleKeydown);
		resize.disconnect();
		if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
	}

	return { applySnapshot, dispose, focusSelected };
}
