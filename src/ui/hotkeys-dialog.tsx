// Native `/hotkeys` handling: `/settings` and `/hotkeys` used to both just open the
// command palette (an action launcher, not a reference list — and one that only lists
// commands with a catalog entry, leaving out the focus-only keybinds in keybinds.ts's
// `focusKeybindIds`). This is a plain, always up to date reference: every shortcut
// pi-ui responds to, searchable, nothing to click.
import { appCommandCatalog } from "../commands/catalog.ts";
import { activeKeybind, type FocusKeybindId } from "../keybinds.ts";
import { formatShortcut, shortcutParts } from "../utils/keyboard.ts";
import { operatingSystem } from "../utils/platform.ts";
import { shortcutGlyph } from "./keyboard.tsx";
import { syncHtml } from "./sync-html.ts";

// A dedicated reference dialog — unlike the ambient `ShortcutKbd` hints elsewhere in the
// UI (`keyboard.tsx`), these must stay visible when the user has turned off keybind hints,
// enabled minimal mode, or is under the 48rem width those hints hide at (misc.css), since
// showing every shortcut is the entire point of opening this dialog.
function ShortcutRef(props: { shortcut: string }) {
	const symbolic = operatingSystem === "darwin";
	const label = symbolic ? formatShortcut(props.shortcut) : undefined;
	return (
		<span class="shortcut hotkeys-row-shortcut" title={label}>
			{shortcutParts(props.shortcut).map((part) => (
				<kbd class="kbd">{symbolic ? shortcutGlyph(part) : part}</kbd>
			))}
		</span>
	);
}

// Focus-only keybinds (see keybinds.ts's focusKeybindIds) have no command-catalog entry
// of their own to source a description from.
const focusShortcutDescriptions: Record<FocusKeybindId, string> = {
	"cycle-model-backward": "Cycle through scoped models, backward",
	"toggle-sessions": "Show or hide the session sidebar",
	"focus-prompt": "Focus the message composer",
	"focus-conversation": "Focus the conversation transcript",
	"focus-sessions": "Focus the session sidebar",
	"focus-workspace-files": "Focus the workspace file tree",
	"focus-workspace-changes": "Focus the workspace Git changes list",
	"focus-workspace-editor": "Focus the workspace file editor",
};

export function renderHotkeysDialog(): string {
	return syncHtml(
		<dialog
			id="hotkeys-dialog"
			class="dialog hotkeys-dialog"
			aria-labelledby="hotkeys-dialog-title"
			data-signals__ifmissing={JSON.stringify({ _hotkeysQuery: "" })}
			data-on:toggle="if (evt.newState === 'open') $_hotkeysQuery = ''"
			closedby="any"
		>
			<div class="hotkeys-dialog-panel">
				<header class="preference-dialog-header">
					<div class="preference-dialog-heading">
						<div>
							<h2 id="hotkeys-dialog-title">Keyboard shortcuts</h2>
							<p class="preference-dialog-description">
								Every shortcut pi-ui responds to.
							</p>
						</div>
					</div>
					<input
						id="hotkeys-search"
						type="search"
						class="input preference-dialog-search"
						placeholder="Search shortcuts…"
						aria-label="Search shortcuts"
						autocomplete="off"
						spellcheck="false"
						autofocus
						data-bind:_hotkeys-query=""
					/>
				</header>
				<ul
					class="preference-dialog-body hotkeys-list"
					aria-label="Keyboard shortcuts"
				>
					{appCommandCatalog
						.filter((command) => command.shortcut)
						.map((command) => (
							<li
								class="hotkeys-row"
								data-attr:hidden={`!${JSON.stringify(`${command.title} ${command.description}`.toLowerCase())}.includes($_hotkeysQuery.trim().toLowerCase())`}
							>
								<span class="hotkeys-row-content command-item-content">
									<span class="command-item-title" safe>
										{command.title}
									</span>
									<span class="command-item-description" safe>
										{command.description}
									</span>
								</span>
								<ShortcutRef shortcut={activeKeybind(command.id)} />
							</li>
						))}
					{Object.entries(focusShortcutDescriptions).map(
						([id, description]) => (
							<li
								class="hotkeys-row"
								data-attr:hidden={`!${JSON.stringify(description.toLowerCase())}.includes($_hotkeysQuery.trim().toLowerCase())`}
							>
								<span class="hotkeys-row-content command-item-content">
									<span class="command-item-title" safe>
										{description}
									</span>
								</span>
								<ShortcutRef
									// SAFETY: `id` is a key of `focusShortcutDescriptions`, declared as
									// `Record<FocusKeybindId, string>` — Object.entries widens keys to
									// `string`, but every runtime value here is a FocusKeybindId variant.
									shortcut={activeKeybind(id as FocusKeybindId)}
								/>
							</li>
						),
					)}
				</ul>
				<footer class="preference-dialog-footer">
					<button
						type="button"
						class="btn"
						data-variant="outline"
						commandfor="hotkeys-dialog"
						command="close"
					>
						Done
					</button>
				</footer>
			</div>
		</dialog>,
	);
}
