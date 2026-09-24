const commandSelector = ".command";
const menuPopoverSelector = "[popover][role='menu']";
const movementKeys = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);
const verticalMovementKeys = new Set(["ArrowDown", "ArrowUp"]);
/** `.command[data-multi-pane]` panes, e.g. the model picker's providers/models panes. */
const paneSelector = "[data-pane]";

export function bindControls() {
	document.addEventListener("keydown", handleKeydown);
	document.addEventListener("mousemove", handlePointerMove);
	document.addEventListener("click", handleClick);
	refreshControls();
}

export function refreshControls(root = document) {
	for (const command of controlsIn(root, commandSelector)) refreshCommand(command);
}

function controlsIn(root, selector) {
	const controls = [];
	if (!root) return controls;
	if (root instanceof Element && root.matches(selector)) controls.push(root);
	for (const element of root.querySelectorAll?.(selector) ?? []) controls.push(element);
	return controls;
}

/** A `.command` with `data-multi-pane="true"` has several `[data-pane]` menus (e.g. the
 * model picker's providers pane and models pane) instead of one; `data-active-pane` on
 * the `.command` says which one currently owns keyboard movement/Enter/`.active`. */
function isMultiPane(command) {
	return command.dataset.multiPane === "true";
}

/** Left/Right switch panes only when the caret already sits at that edge of the search
 * text with nothing selected, so they still move the caret while editing a query. */
export function caretAtEdge(input, key) {
	const { selectionStart, selectionEnd, value } = input;
	if (selectionStart === null || selectionStart !== selectionEnd) return false;
	return key === "ArrowLeft" ? selectionStart === 0 : selectionEnd === value.length;
}

function commandPanes(command) {
	return [...command.querySelectorAll(paneSelector)];
}

function activeMenu(command) {
	if (!isMultiPane(command)) return command.querySelector('[role="menu"]');
	const panes = commandPanes(command);
	return (
		panes.find((pane) => pane.dataset.pane === command.dataset.activePane) ?? panes[0]
	);
}

function commandParts(command) {
	return {
		input: command.querySelector("header input"),
		menu: activeMenu(command),
	};
}

function commandItems(menu) {
	return [...menu.querySelectorAll('[role="menuitem"]')].filter(
		(item) => item instanceof HTMLElement && !isDisabled(item),
	);
}

/** Items the user can actually see: not `hidden` themselves and not inside a `hidden`
 * group (the model picker hides whole provider groups, not their rows), so a refresh
 * never marks an invisible row `.active` for Enter to pick. */
export function visibleCommandItems(command) {
	const { menu } = commandParts(command);
	if (!(menu instanceof HTMLElement)) return [];
	return commandItems(menu).filter((item) => !item.closest("[hidden]"));
}

function refreshCommand(command) {
	const { input, menu } = commandParts(command);
	if (!(input instanceof HTMLInputElement) || !(menu instanceof HTMLElement)) return;
	menu.scrollTop = 0;
	activateCommandItem(command, visibleCommandItems(command)[0]);
}

export function activateCommandItem(command, active) {
	const { input, menu } = commandParts(command);
	if (!(input instanceof HTMLInputElement) || !(menu instanceof HTMLElement)) return;
	// Every pane's `.active` is cleared, not just the current pane's: entering a pane
	// (arrow key or a provider click) always starts from a single, unambiguous item.
	for (const item of command.querySelectorAll('[role="menuitem"].active')) {
		item.classList.remove("active");
	}
	if (active instanceof HTMLElement) {
		active.classList.add("active");
		if (active.id) input.setAttribute("aria-activedescendant", active.id);
		else input.removeAttribute("aria-activedescendant");
	} else {
		input.removeAttribute("aria-activedescendant");
	}
}

function moveCommand(command, key) {
	const items = visibleCommandItems(command);
	if (items.length === 0) return;
	const active = items.findIndex((item) => item.classList.contains("active"));
	let index = active;
	if (key === "ArrowDown") index = Math.min(active + 1, items.length - 1);
	if (key === "ArrowUp") index = Math.max(active < 0 ? 0 : active - 1, 0);
	if (key === "Home") index = 0;
	if (key === "End") index = items.length - 1;
	const item = items[index];
	activateCommandItem(command, item);
	item?.scrollIntoView({ block: "nearest" });
}

function menuPopoverItems(popover) {
	return [...popover.querySelectorAll('[role^="menuitem"]')].filter(
		(item) => item instanceof HTMLElement && !isDisabled(item),
	);
}

function moveInMenuPopover(popover, key) {
	const items = menuPopoverItems(popover);
	if (items.length === 0) return;
	const active = items.indexOf(document.activeElement);
	let index = active;
	if (key === "ArrowDown") index = Math.min(active + 1, items.length - 1);
	if (key === "ArrowUp")
		index = active < 0 ? items.length - 1 : Math.max(active - 1, 0);
	if (key === "Home") index = 0;
	if (key === "End") index = items.length - 1;
	items[index]?.focus({ preventScroll: true });
}

function handleKeydown(event) {
	if (!(event.target instanceof Element)) return;
	const command = event.target.closest(commandSelector);
	if (command instanceof HTMLElement && event.target.matches("header input")) {
		if (event.isComposing) return;
		if (event.key === "Enter") {
			const active = visibleCommandItems(command).find((item) =>
				item.classList.contains("active"),
			);
			if (active) {
				event.preventDefault();
				active.click();
			}
			return;
		}
		if (movementKeys.has(event.key)) {
			event.preventDefault();
			moveCommand(command, event.key);
			return;
		}
		if (
			isMultiPane(command) &&
			(event.key === "ArrowRight" || event.key === "ArrowLeft") &&
			caretAtEdge(event.target, event.key)
		) {
			// A pane switch is expressed as a click, so it runs through the exact same
			// handler as the mouse/Enter path: `window.piUi.modelPicker.selectProvider`
			// drills right into a provider's models, and the `[data-pane-back]` button
			// (rendered only when there's more than one pane) backs left out of them.
			const panes = commandPanes(command);
			const index = panes.findIndex(
				(pane) => pane.dataset.pane === command.dataset.activePane,
			);
			if (event.key === "ArrowRight" && index >= 0 && index < panes.length - 1) {
				event.preventDefault();
				visibleCommandItems(command)
					.find((item) => item.classList.contains("active"))
					?.click();
				return;
			}
			if (event.key === "ArrowLeft" && index > 0) {
				event.preventDefault();
				command.querySelector("[data-pane-back]")?.click();
				return;
			}
		}
	}

	const menuPopover = event.target.closest(menuPopoverSelector);
	if (menuPopover instanceof HTMLElement) {
		if (event.key === "Tab") menuPopover.hidePopover();
		if (movementKeys.has(event.key)) {
			event.preventDefault();
			moveInMenuPopover(menuPopover, event.key);
		}
		return;
	}

	if (!(event.target instanceof HTMLButtonElement)) return;
	const target = event.target.popoverTargetElement;
	if (target?.matches(menuPopoverSelector) && verticalMovementKeys.has(event.key)) {
		event.preventDefault();
		event.target.click();
		const items = menuPopoverItems(target);
		const item = event.key === "ArrowUp" ? items.at(-1) : items[0];
		item?.focus({ preventScroll: true });
	}
}

function handlePointerMove(event) {
	if (!(event.target instanceof Element)) return;
	const option = event.target.closest('[role="option"]');
	if (
		option instanceof HTMLElement &&
		option.getAttribute("aria-selected") !== "true"
	) {
		activateListboxOption(option);
	}
	const commandItem = event.target.closest('[role="menuitem"]');
	const command = commandItem?.closest(commandSelector);
	if (
		command instanceof HTMLElement &&
		commandItem instanceof HTMLElement &&
		!commandItem.hidden &&
		!commandItem.classList.contains("active")
	) {
		activateCommandItem(command, commandItem);
	}
}

function activateListboxOption(active) {
	const listbox = active.closest('[role="listbox"]');
	if (!(listbox instanceof HTMLElement)) return;
	for (const option of listbox.querySelectorAll(
		'[role="option"][aria-selected="true"]',
	)) {
		option.setAttribute("aria-selected", "false");
	}
	active.setAttribute("aria-selected", "true");
	const input = document.querySelector(`[aria-controls="${CSS.escape(listbox.id)}"]`);
	input?.setAttribute("aria-activedescendant", active.id);
}

function handleClick(event) {
	if (!(event.target instanceof Element)) return;
	const commandItem = event.target.closest('.command [role="menuitem"]');
	if (
		commandItem instanceof HTMLElement &&
		!commandItem.hasAttribute("data-keep-command-open")
	) {
		commandItem.closest("dialog")?.close();
	}
}

function isDisabled(element) {
	return (
		element.hasAttribute("disabled") ||
		element.getAttribute("aria-disabled") === "true" ||
		element.getAttribute("data-disabled") === "true"
	);
}
