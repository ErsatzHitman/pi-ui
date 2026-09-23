import { toggleLiveWorkspaceAction } from "../commands/actions.ts";
import {
	isPiUiSheetElement,
	type PiUiElement,
	piUiDialogId,
} from "../extension-surface-types.ts";
import { activeKeybind, keybindAction, keybindAria } from "../keybinds.ts";
import {
	liveWorkspaceRatioDefault,
	liveWorkspaceRatioMax,
	liveWorkspaceRatioMin,
	liveWorkspaceTabs,
	type LiveWorkspaceAgentRow,
	type LiveWorkspacePreferences,
	type LiveWorkspaceSnapshot,
	type LiveWorkspaceTab,
	type LiveWorkspaceTurnState,
} from "../live-workspace-types.ts";
import { endpoints } from "../server/routes/endpoints.ts";
import type { AppStateSnapshot, AppUsage } from "../state/app-store.ts";
import { formatTokens } from "../utils/format.ts";
import { Icon } from "./icon.tsx";
import { Activity, Bot, Gauge, List, X } from "./icons.ts";
import { ShortcutKbd, ShortcutTooltip } from "./keyboard.tsx";
import { renderPiUiElement } from "./pi-ui-elements.tsx";
import { resumeSessionAction } from "./session-transition.tsx";
import { syncHtml } from "./sync-html.ts";

/** Extension state the Extensions tab reads straight from AppStore (one source of truth). */
export type LiveWorkspaceExtensions = Pick<
	AppStateSnapshot,
	"extensionElements" | "extensionChannels"
>;

const noExtensions: LiveWorkspaceExtensions = {
	extensionElements: [],
	extensionChannels: [],
};

const tabLabels: Record<LiveWorkspaceTab, string> = {
	now: "Now",
	agents: "Agents",
	usage: "Usage",
	activity: "Activity",
	extensions: "Extensions",
};

const tabIcons: Record<LiveWorkspaceTab, typeof Activity> = {
	now: Activity,
	agents: Bot,
	usage: Gauge,
	activity: List,
	extensions: Bot,
};

/** Mirrors `workspace-review.tsx`'s resize-handle factory, scoped to the single `ratio` preference. */
function ratioResizeHandleAttributes() {
	const value = "$liveWorkspacePreferences.ratio";
	const normalize = `${value} = Math.min(
		${liveWorkspaceRatioMax},
		Math.max(${liveWorkspaceRatioMin}, ${value} || ${liveWorkspaceRatioDefault}),
	);`;
	const commit = `document.body.dispatchEvent(new CustomEvent(
		'pi-ui-live-workspace-preferences',
		{ detail: { ratio: ${value} } },
	));`;
	const finish = `if (el.hasPointerCapture(evt.pointerId)) {
		${normalize}
		document.documentElement.classList.remove('is-resizing');
		${commit}
	}`;
	// The handle sits left of the pane, so dragging it left (toward the chat) must widen the
	// pane: the ratio tracks how far the pointer moved back toward the right edge of the shell.
	const scale =
		"Math.max(1, document.getElementById('workspace-shell').clientWidth - 12)";
	return {
		"data-on:pointerdown": `if (evt.button === 0) {
			el.dataset.resizePointer = evt.clientX;
			el.dataset.resizeStart = ${value} || ${liveWorkspaceRatioDefault};
			el.setPointerCapture(evt.pointerId);
			document.documentElement.classList.add('is-resizing');
		}`,
		"data-on:pointermove__throttle.8ms": `if (el.hasPointerCapture(evt.pointerId)) {
			${value} = Number(el.dataset.resizeStart) -
				(evt.clientX - Number(el.dataset.resizePointer)) / (${scale});
		}`,
		"data-on:pointerup": finish,
		"data-on:pointercancel": finish,
		"data-on:dblclick": `${value} = ${liveWorkspaceRatioDefault}; ${commit}`,
		"data-on:keydown": `if (evt.code === 'ArrowLeft' || evt.code === 'ArrowRight') {
			evt.preventDefault();
			const direction = evt.code === 'ArrowLeft' ? 1 : -1;
			${value} = (${value} || ${liveWorkspaceRatioDefault}) +
				direction * (evt.shiftKey ? 0.08 : 0.02);
			${normalize}
			${commit}
		}`,
	};
}

/** The toolbar button that opens/closes the pane; rendered in `page.tsx`'s toolbar-end column. */
export function renderLiveWorkspaceToggle(_state: AppStateSnapshot): string {
	return syncHtml(
		<button
			id="live-workspace-toggle"
			type="button"
			class="btn live-workspace-toggle"
			data-variant="ghost"
			data-attr:data-variant="$_liveWorkspaceOpen ? 'secondary' : 'ghost'"
			data-size="icon-sm"
			aria-label="Toggle Live Workspace"
			aria-pressed="false"
			data-attr:aria-pressed="$_liveWorkspaceOpen ? 'true' : 'false'"
			aria-keyshortcuts={keybindAria("toggle-live-workspace")}
			data-on:click={toggleLiveWorkspaceAction()}
			data-on:keydown__window={keybindAction(
				"toggle-live-workspace",
				toggleLiveWorkspaceAction(),
			)}
			data-tooltip="Toggle Live Workspace"
			data-tooltip-delay
			data-align="end"
		>
			<Icon icon={Activity} />
			<ShortcutTooltip
				label="Toggle Live Workspace"
				shortcut={activeKeybind("toggle-live-workspace")}
			/>
		</button>,
	);
}

/** The pane shell, mounted once in `page.tsx` alongside `#workspace-review`. */
export function renderLiveWorkspace(
	snapshot: LiveWorkspaceSnapshot,
	preferences: LiveWorkspacePreferences,
	usage: AppUsage,
	extensions: LiveWorkspaceExtensions = noExtensions,
): string {
	return syncHtml(
		<section
			id="live-workspace"
			aria-label="Live Workspace"
			aria-keyshortcuts={keybindAria("toggle-live-workspace")}
			aria-hidden="true"
			inert
			data-attr:aria-hidden="$_liveWorkspaceOpen ? 'false' : 'true'"
			data-attr:inert="!$_liveWorkspaceOpen"
			data-on:keydown={`if (evt.code === 'Escape') { $_liveWorkspaceOpen = false; }`}
		>
			<div
				id="live-workspace-separator"
				class="resize-handle"
				role="separator"
				tabindex="0"
				aria-label="Resize Live Workspace"
				aria-orientation="vertical"
				aria-valuemin={liveWorkspaceRatioMin * 100}
				aria-valuemax={liveWorkspaceRatioMax * 100}
				data-attr:aria-valuenow={`Math.round(($liveWorkspacePreferences.ratio || ${liveWorkspaceRatioDefault}) * 100)`}
				attrs={ratioResizeHandleAttributes()}
			/>
			<div
				id="live-workspace-drag-handle"
				class="live-workspace-drag-handle"
				aria-hidden="true"
			/>
			<header class="live-workspace-header">
				<div
					class="segmented-control live-workspace-tabs"
					aria-label="Live Workspace tabs"
				>
					{liveWorkspaceTabs.map((tab) => (
						<button
							type="button"
							class="live-workspace-tab-button"
							aria-pressed={tab === "now" ? "true" : "false"}
							data-attr:aria-pressed={`$liveWorkspacePreferences.tab === '${tab}' || (!$liveWorkspacePreferences.tab && '${tab}' === 'now') ? 'true' : 'false'`}
							data-on:click={`
								$liveWorkspacePreferences.tab = '${tab}';
								document.body.dispatchEvent(new CustomEvent(
									'pi-ui-live-workspace-preferences',
									{ detail: { tab: '${tab}' } },
								));
							`}
						>
							<Icon icon={tabIcons[tab]} />
							<span>{tabLabels[tab]}</span>
						</button>
					))}
				</div>
				<button
					type="button"
					class="btn live-workspace-close"
					data-variant="ghost"
					data-size="icon-xs"
					data-on:click="$_liveWorkspaceOpen = false"
					aria-label="Hide Live Workspace"
				>
					<Icon icon={X} />
					<ShortcutKbd shortcut={activeKeybind("toggle-live-workspace")} />
				</button>
			</header>
			<div class="live-workspace-body raised-surface">
				{renderLiveWorkspaceData(snapshot, preferences, usage, extensions)}
			</div>
		</section>,
	);
}

/** The patchable data region; also re-rendered wholesale on a fresh `/stream` connection. */
export function renderLiveWorkspaceData(
	snapshot: LiveWorkspaceSnapshot,
	preferences: LiveWorkspacePreferences,
	usage: AppUsage,
	extensions: LiveWorkspaceExtensions = noExtensions,
): string {
	const tab = preferences.tab ?? "now";
	return syncHtml(
		<div id="live-workspace-data">
			<section
				id="live-workspace-now"
				aria-label="Now"
				data-show="($liveWorkspacePreferences.tab || 'now') === 'now'"
				style={tab === "now" ? undefined : "display: none"}
			>
				{renderNowTab(snapshot)}
			</section>
			<section
				id="live-workspace-agents"
				aria-label="Agents"
				data-show="$liveWorkspacePreferences.tab === 'agents'"
				style={tab === "agents" ? undefined : "display: none"}
			>
				{renderAgentsTab(snapshot)}
			</section>
			<section
				id="live-workspace-usage"
				aria-label="Usage"
				data-show="$liveWorkspacePreferences.tab === 'usage'"
				style={tab === "usage" ? undefined : "display: none"}
			>
				{renderUsageTab(usage)}
			</section>
			<section
				id="live-workspace-activity"
				aria-label="Activity"
				data-show="$liveWorkspacePreferences.tab === 'activity'"
				style={tab === "activity" ? undefined : "display: none"}
			>
				{renderActivityTab(snapshot)}
			</section>
			<section
				id="live-workspace-extensions"
				aria-label="Extensions"
				data-show="$liveWorkspacePreferences.tab === 'extensions'"
				style={tab === "extensions" ? undefined : "display: none"}
			>
				{renderExtensionsTab(extensions)}
			</section>
		</div>,
	);
}

function renderNowTab(snapshot: LiveWorkspaceSnapshot): string {
	return syncHtml(
		<div class="live-workspace-panel">
			{renderTurnBanner(snapshot.turn)}
			{(snapshot.queuedSteering > 0 || snapshot.queuedFollowUp > 0) && (
				<p class="fine-print live-workspace-queue-note">
					{snapshot.queuedSteering > 0 && (
						<span>
							{snapshot.queuedSteering} queued steering message
							{snapshot.queuedSteering === 1 ? "" : "s"}
						</span>
					)}
					{snapshot.queuedSteering > 0 && snapshot.queuedFollowUp > 0 && " · "}
					{snapshot.queuedFollowUp > 0 && (
						<span>
							{snapshot.queuedFollowUp} queued follow-up
							{snapshot.queuedFollowUp === 1 ? "" : "s"}
						</span>
					)}
				</p>
			)}
			<h3 class="live-workspace-section-heading">Active tools</h3>
			{snapshot.activeTools.length === 0 ? (
				<p class="fine-print live-workspace-empty">No tools running.</p>
			) : (
				<ul class="live-workspace-tool-list">
					{snapshot.activeTools.map((tool) => (
						<li class="live-workspace-tool-row">
							<span class="live-workspace-tool-name" safe>
								{tool.summary ?? tool.toolName}
							</span>
							<span
								class="fine-print live-workspace-tool-elapsed"
								data-live-workspace-elapsed={tool.startedAt}
							/>
							{tool.preview && (
								<pre class="live-workspace-tool-preview" safe>
									{tool.preview}
								</pre>
							)}
						</li>
					))}
				</ul>
			)}
		</div>,
	);
}

function renderTurnBanner(turn: LiveWorkspaceTurnState | undefined): string {
	if (!turn) {
		return syncHtml(
			<p class="fine-print live-workspace-empty">No turn in progress.</p>,
		);
	}
	const label = turnLabel(turn);
	const canAbort = turn.phase === "running" || turn.phase === "retrying";
	return syncHtml(
		<div class="live-workspace-turn-banner" data-turn-phase={turn.phase}>
			<span class="live-workspace-turn-label" safe>
				{label}
			</span>
			{canAbort && (
				<button
					type="button"
					class="btn"
					data-variant="outline"
					data-size="xs"
					data-on:click={`@post('${endpoints.abort}', { payload: {} })`}
				>
					Abort
				</button>
			)}
		</div>,
	);
}

function turnLabel(turn: LiveWorkspaceTurnState): string {
	if (turn.phase === "waiting-for-extension") {
		return `Waiting for extension UI${turn.waitingTitle ? `: ${turn.waitingTitle}` : ` (${turn.waitingKind})`}`;
	}
	if (turn.phase === "compacting") {
		return `Compacting context (${turn.compactionReason})`;
	}
	if (turn.phase === "retrying") {
		const countdown =
			turn.retryAt !== undefined
				? Math.max(0, turn.retryAt - Date.now())
				: undefined;
		const attempts =
			turn.retryAttempt !== undefined && turn.retryMaxAttempts !== undefined
				? ` ${turn.retryAttempt}/${turn.retryMaxAttempts}`
				: "";
		return `Retrying${attempts}${countdown ? ` in ${Math.ceil(countdown / 1000)}s` : ""}`;
	}
	return "Running";
}

function renderAgentsTab(snapshot: LiveWorkspaceSnapshot): string {
	if (snapshot.agents.length === 0) {
		return syncHtml(
			<p class="fine-print live-workspace-empty">
				No subagents, background jobs, or background sessions.
			</p>,
		);
	}
	return syncHtml(
		<ul class="live-workspace-agent-list">
			{snapshot.agents.map((agent) => renderAgentRow(agent))}
		</ul>,
	);
}

function renderAgentRow(agent: LiveWorkspaceAgentRow): string {
	return syncHtml(
		<li
			class="live-workspace-agent-row"
			style={agent.depth > 0 ? `padding-left: ${agent.depth}rem` : undefined}
		>
			<span class="live-workspace-agent-label" safe>
				{agent.label}
			</span>
			<span class="fine-print live-workspace-agent-status" safe>
				{agent.status}
			</span>
			{agent.tokens !== undefined && (
				<span class="fine-print live-workspace-agent-tokens">
					{formatTokens(agent.tokens)} tok
				</span>
			)}
			{agent.activeToolCount !== undefined && agent.activeToolCount > 0 && (
				<span class="fine-print live-workspace-agent-tools">
					{agent.activeToolCount} tool{agent.activeToolCount === 1 ? "" : "s"}{" "}
					running
				</span>
			)}
			{agent.kind === "background-session" && (
				<button
					type="button"
					class="btn"
					data-variant="outline"
					data-size="xs"
					data-on:click={resumeSessionAction(agent.id)}
				>
					Open
				</button>
			)}
		</li>,
	);
}

function renderUsageTab(usage: AppUsage): string {
	const contextPercent = usage.contextPercent ?? 0;
	return syncHtml(
		<div class="live-workspace-panel">
			<dl class="live-workspace-usage-grid">
				<div>
					<dt>Session</dt>
					<dd safe>{usage.text}</dd>
				</div>
				<div>
					<dt>Cost</dt>
					<dd safe>{usage.costText}</dd>
				</div>
				{usage.cacheHitPercent !== undefined && (
					<div>
						<dt>Cache hit</dt>
						<dd>{Math.round(usage.cacheHitPercent)}%</dd>
					</div>
				)}
			</dl>
			{usage.contextTokens !== undefined && usage.contextWindow !== undefined && (
				<div class="live-workspace-context-meter">
					<div class="fine-print">
						Context: {formatTokens(usage.contextTokens)} /{" "}
						{formatTokens(usage.contextWindow)} ({Math.round(contextPercent)}
						%)
					</div>
					<div
						class="live-workspace-meter-track"
						role="meter"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(contextPercent)}
					>
						<div
							class="live-workspace-meter-fill"
							style={`width: ${Math.min(100, Math.max(0, contextPercent))}%`}
						/>
					</div>
				</div>
			)}
			{usage.limits && usage.limits.windows.length > 0 && (
				<div class="live-workspace-limits">
					<h3 class="live-workspace-section-heading" safe>
						{usage.limits.label}
					</h3>
					<ul class="live-workspace-limits-list">
						{usage.limits.windows.map((window) => (
							<li>
								<span safe>{window.label}</span>
								<span class="fine-print" safe>
									{Math.round(window.usedPercent)}% used · resets{" "}
									{window.resetText}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>,
	);
}

function renderActivityTab(snapshot: LiveWorkspaceSnapshot): string {
	return syncHtml(
		<div class="live-workspace-panel">
			<div class="live-workspace-activity-header">
				<span class="fine-print">{snapshot.activity.length} events</span>
				<button
					type="button"
					class="btn"
					data-variant="ghost"
					data-size="xs"
					data-on:click={`@post('${endpoints.liveWorkspaceClearActivity}', { payload: {} })`}
					disabled={snapshot.activity.length === 0}
				>
					Clear
				</button>
			</div>
			{snapshot.activity.length === 0 ? (
				<p class="fine-print live-workspace-empty">No activity recorded yet.</p>
			) : (
				<ul class="live-workspace-activity-list">
					{snapshot.activity.map((entry) => (
						<li
							class="live-workspace-activity-row"
							data-activity-kind={entry.kind}
							data-background={entry.background || undefined}
						>
							<span class="live-workspace-activity-text" safe>
								{entry.text}
							</span>
							<span
								class="fine-print live-workspace-activity-time"
								data-live-workspace-elapsed={entry.at}
							/>
						</li>
					))}
				</ul>
			)}
		</div>,
	);
}

function renderExtensionsTab(extensions: LiveWorkspaceExtensions): string {
	const elements = extensions.extensionElements.filter(
		(element) => element.kind !== "composer",
	);
	const inline = elements.filter((element) => !isPiUiSheetElement(element));
	const sheets = elements.filter(isPiUiSheetElement);
	const channels = extensions.extensionChannels;
	if (elements.length === 0 && channels.length === 0) {
		return syncHtml(
			<p class="fine-print live-workspace-empty">
				No extension UI or channel activity observed yet.
			</p>,
		);
	}
	return syncHtml(
		<div class="live-workspace-panel">
			{inline.length > 0 && (
				<>
					<h3 class="live-workspace-section-heading">Extension UI</h3>
					<div class="piui-widgets live-workspace-piui-elements">
						{inline.map((element) => renderPiUiElement(element))}
					</div>
				</>
			)}
			{sheets.length > 0 && (
				<>
					<h3 class="live-workspace-section-heading">Extension panels</h3>
					<ul class="live-workspace-channel-list">
						{sheets.map((element) => renderSheetRow(element))}
					</ul>
				</>
			)}
			{channels.length > 0 && (
				<>
					<h3 class="live-workspace-section-heading">Channels</h3>
					<ul class="live-workspace-channel-list">
						{channels.map((channel) => (
							<li class="live-workspace-channel-row">
								<header>
									<span class="live-workspace-channel-name" safe>
										{channel.channel}
									</span>
									<span
										class="fine-print live-workspace-activity-time"
										data-live-workspace-elapsed={channel.updatedAt}
									/>
								</header>
								<pre class="live-workspace-channel-payload" safe>
									{JSON.stringify(channel.payload, null, 2)}
								</pre>
							</li>
						))}
					</ul>
				</>
			)}
		</div>,
	);
}

/** Sheet elements already own a `<dialog>` (see pi-ui-elements.tsx); this row reopens it. */
function renderSheetRow(element: PiUiElement): string {
	return syncHtml(
		<li class="live-workspace-agent-row">
			<span class="live-workspace-agent-label" safe>
				{element.title ?? element.id}
			</span>
			<span class="fine-print live-workspace-agent-status" safe>
				{element.ns}
			</span>
			<button
				type="button"
				class="btn"
				data-variant="outline"
				data-size="xs"
				commandfor={piUiDialogId(element)}
				command="show-modal"
			>
				Open
			</button>
		</li>,
	);
}
