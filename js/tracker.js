/* ============================================================================
 * tracker.js — Daily Time Tracker View
 * ============================================================================
 * Renders the main daily tracking interface:
 *   - Day navigation with week bar
 *   - Vertical time grid with 30-minute blocks
 *   - Click-to-assign category dropdown
 *   - Inline detail editing (sub-category, billable, merchant, etc.)
 *   - Drag-to-fill for multiple blocks
 *   - Right sidebar with daily/weekly summary stats
 *
 * This module is initialized by app.js when the tracker view is active.
 * ========================================================================= */

import { CATEGORIES, TIME_DEFAULTS, TARGETS } from "./config.js";
import {
	getEntriesForDate,
	saveEntry,
	deleteEntry,
	getEntriesForDateRange,
	getTierMap,
	getWeeklyNotes,
	saveWeeklyNotes,
} from "./db.js";
import {
	generateTimeSlots,
	formatTimeSlot,
	formatDateISO,
	formatDateDisplay,
	formatDateShort,
	getWeekDates,
	getISOWeekKey,
	parseDate,
	countTrackedHours,
	aggregateByTier,
	countBillableHours,
} from "./utils.js";

/* ============================================================================
 * MODULE STATE
 * --------------------------------------------------------------------------
 * Local state for the tracker view. Reset/updated when the view initializes.
 * ========================================================================= */

let currentDate = new Date(); // The currently displayed day
let timeSlots = []; // Array of time slot strings for the grid
let entries = {}; // Map of timeSlot → entry data for current day
let appState = null; // Reference to the global app state
let activeDropdown = null; // Currently open edit dropdown element
let weekDates = []; // Mon-Fri dates for the current week
let clipboard = null; // Stores the copied entry data (without date/timeSlot)
let isShiftDown = false; // Tracks if Shift key is held for range fill
let lastClickedSlot = null; // The last block clicked — used as range fill anchor
let activeView = "day"; // 'day' or 'week' — which sub-view is active

/* Track Shift key state globally for range-fill */
document.addEventListener("keydown", (e) => {
	/* Ignore keyboard shortcuts when user is typing in a text field */
	const tag = e.target.tagName;
	const isTyping =
		tag === "INPUT" ||
		tag === "TEXTAREA" ||
		tag === "SELECT" ||
		e.target.isContentEditable;

	if (e.key === "Shift") isShiftDown = true;

	if (e.key === "Escape") {
		if (activeDropdown) {
			closeDropdown();
			return;
		}
		const popover = document.getElementById("week-popover");
		if (popover) {
			closeWeekPopover();
			return;
		}
		if (clipboard) {
			clipboard = null;
			updateClipboardIndicator();
		}
	}

	/* View switching shortcuts — only when not typing */
	if (!isTyping && !e.ctrlKey && !e.metaKey && !e.altKey) {
		if (e.key === "d" || e.key === "D") {
			closeDropdown();
			closeWeekPopover();
			activeView = "day";
			renderTracker();
		}
		if (e.key === "w" || e.key === "W") {
			closeDropdown();
			closeWeekPopover();
			activeView = "week";
			renderWeekView();
		}
		if (e.key === "n" || e.key === "N") {
			closeDropdown();
			closeWeekPopover();
			activeView = "notes";
			renderNotesView();
		}
	}
});
document.addEventListener("keyup", (e) => {
	if (e.key === "Shift") isShiftDown = false;
});

/* Global click-outside handler — runs once, handles both views */
document.addEventListener("click", (e) => {
	/* Ignore clicks inside dropdowns and popovers */
	if (e.target.closest(".edit-dropdown")) return;
	if (e.target.closest(".week-popover")) return;

	/* Ignore clicks on time blocks (they have their own handlers) */
	if (e.target.closest(".time-block-empty")) return;
	if (e.target.closest(".time-block-filled")) return;
	if (e.target.closest(".week-block")) return;
	if (e.target.closest(".time-row")) return;

	/* Ignore clicks on nav buttons and controls */
	if (e.target.closest("button")) return;
	if (e.target.closest("input")) return;
	if (e.target.closest("select")) return;

	/* If we get here, the click was outside everything — close whatever's open */
	closeDropdown();
	closeWeekPopover();
});

/* ============================================================================
 * INITIALIZATION
 * ========================================================================= */

/**
 * initTracker
 * Called by app.js when the tracker view becomes active.
 * Sets up the time grid and renders the current day.
 *
 * @param {Object} state - The global app state (settings, tierMap)
 */
export async function initTracker(state) {
	appState = state;

	/* Generate time slots based on user's configured work hours */
	const startHour = state.settings.dayStartHour || TIME_DEFAULTS.dayStartHour;
	const endHour = state.settings.dayEndHour || TIME_DEFAULTS.dayEndHour;
	timeSlots = generateTimeSlots(startHour, endHour);

	/* Calculate the week dates for the navigation bar */
	weekDates = getWeekDates(currentDate);

	/* Render the full tracker UI */
	await renderTracker();
}

/* ============================================================================
 * MAIN RENDER
 * --------------------------------------------------------------------------
 * Builds the complete tracker view HTML and inserts it into the DOM.
 * ========================================================================= */

async function renderTracker() {
	/* If week view is active, delegate to the week renderer */
	if (activeView === "week") {
		await renderWeekView();
		return;
	}
	if (activeView === "notes") {
		await renderNotesView();
		return;
	}

	const container = document.getElementById("view-tracker");

	/* Load entries for the current day from IndexedDB */
	const dayEntries = await getEntriesForDate(formatDateISO(currentDate));

	/* Build a lookup map: timeSlot → entry for quick access */
	entries = {};
	dayEntries.forEach((e) => {
		entries[e.timeSlot] = e;
	});

	/* Calculate sidebar stats */
	const sidebarStats = await calculateSidebarStats();

	/* Build the HTML */
	container.innerHTML = `
    <!-- ================================================================
        DAY NAVIGATION
        Date display with prev/next arrows and week day chips.
        ================================================================ -->
    <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
            <button id="prev-day" class="w-8 h-8 flex items-center justify-center rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 hover:border-stone-300 transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
                </svg>
            </button>
            <span id="current-date" class="text-sm font-medium min-w-[160px] text-center">${formatDateDisplay(currentDate)}</span>
            <button id="next-day" class="w-8 h-8 flex items-center justify-center rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 hover:border-stone-300 transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                </svg>
            </button>
        </div>

        <!-- Quick actions -->
        <div class="flex items-center gap-2">
            <button id="btn-fill-lunch" class="text-xs px-3 py-1.5 rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 hover:border-stone-300 transition-colors">
                Fill lunch
            </button>
            <button id="btn-today" class="text-xs px-3 py-1.5 rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 hover:border-stone-300 transition-colors">
                Today
            </button>
        </div>

		<!-- View toggle -->
		<div class="flex gap-1 bg-surface-100 rounded-lg p-0.5">
		<button id="toggle-day" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
			${activeView === "day" ? "bg-white text-stone-700 font-medium shadow-sm " : "text-stone-400 hover:text-stone-600"}">Day (D)</button>
		<button id="toggle-week" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
			${activeView === "week" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Week (W)</button>
		<button id="toggle-notes" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
			${activeView === "notes" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Notes (N)</button>
		</div>
    </div>

    <!-- Week day chips -->
    <div class="flex gap-1 mb-6" style="padding-right: calc(224px + 24px);">
        ${weekDates
					.map((d) => {
						const isActive = formatDateISO(d) === formatDateISO(currentDate);
						return `
            <button class="week-chip flex-1 py-2 text-center text-xs rounded-lg transition-colors
                ${
									isActive
										? "active-chip text-chronos-600 font-medium"
										: "bg-surface-100 text-stone-400 hover:bg-surface-200"
								}"
                data-date="${formatDateISO(d)}">
                ${formatDateShort(d)}
            </button>
        `;
					})
					.join("")}
    </div>

    <!-- ================================================================
        MAIN CONTENT: TIME GRID + SIDEBAR
	================================================================ -->
    <div class="flex gap-6">

        <!-- Time grid (left) -->
        <div class="flex-1" id="time-grid">
            ${timeSlots.map((slot) => renderTimeBlock(slot)).join("")}
        </div>

		<!-- Sidebar stats (right) -->
		<div class="w-56 flex-shrink-0 space-y-3">
			${renderSidebar(sidebarStats)}
		</div>

    </div>
    `;

	/* Attach event listeners after rendering */
	attachEventListeners();

	/* Re-show clipboard indicator if clipboard is active */
	if (clipboard) updateClipboardIndicator();
}

/* ============================================================================
 * TIME BLOCK RENDERING
 * --------------------------------------------------------------------------
 * Renders a single 30-minute time block row. Shows either the assigned
 * category with its details or an empty "click to track" prompt.
 * ========================================================================= */

/**
 * renderTimeBlock
 * Generates the HTML for one time slot row.
 *
 * @param {string} slot - Time slot string, e.g., '09:00'
 * @returns {string} HTML string
 */
function renderTimeBlock(slot) {
	const entry = entries[slot];
	const isLunch = entry && entry.category === "lunch";

	if (entry && entry.category) {
		/* --- FILLED BLOCK --- */
		const cat = CATEGORIES.find((c) => c.id === entry.category);
		const label = cat ? cat.label : entry.category;

		return `
      <div class="time-row flex items-stretch border-b border-stone-100 relative"
           data-slot="${slot}">
        <!-- Time label -->
        <div class="w-14 flex-shrink-0 pt-2.5 text-xs text-stone-400 select-none">
          ${formatTimeSlot(slot)}
        </div>
        <!-- Filled block content -->
        <div class="flex-1 time-block-filled cat-${entry.category} rounded-md px-3 py-2 my-0.5 flex items-center gap-2 min-h-[40px]"
             data-slot="${slot}">
          <span class="text-xs font-medium ${isLunch ? "text-stone-400" : "text-stone-700"}">${label}</span>
          ${entry.subCategory ? `<span class="text-xs text-stone-400">${entry.subCategory}</span>` : ""}
          <div class="ml-auto flex items-center gap-2">
            ${entry.urgent ? '<span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>' : ""}
            ${entry.billable ? '<span class="text-[10px] font-medium text-emerald-500">$</span>' : ""}
            ${entry.ticketLink ? `<span class="text-[10px] text-blue-400">#${entry.ticketLink.split("/").pop()}</span>` : ""}
          </div>
        </div>
      </div>
    `;
	} else {
		/* --- EMPTY BLOCK --- */
		return `
      <div class="time-row flex items-stretch border-b border-stone-100 relative"
           data-slot="${slot}">
        <div class="w-14 flex-shrink-0 pt-2.5 text-xs text-stone-400 select-none">
          ${formatTimeSlot(slot)}
        </div>
        <div class="flex-1 time-block-empty rounded-md px-3 py-2 my-0.5 flex items-center min-h-[40px]"
             data-slot="${slot}">
          <span class="text-xs" style="color: var(--text-muted);">Click to track...</span>
        </div>
      </div>
    `;
	}
}

/* ============================================================================
 * SIDEBAR RENDERING
 * ========================================================================= */

/**
 * calculateSidebarStats
 * Computes the summary metrics displayed in the right sidebar.
 *
 * @returns {Promise<Object>} Stats object with daily and weekly totals
 */
async function calculateSidebarStats() {
	const tierMap = await getTierMap();

	/* --- Daily stats --- */
	const dayEntries = Object.values(entries).filter((e) => e.category);
	const dailyTracked = countTrackedHours(dayEntries);
	const dailyBillable = countBillableHours(dayEntries);
	const dailyTiers = aggregateByTier(dayEntries, tierMap);

	/* --- Weekly stats --- */
	const weekStart = formatDateISO(weekDates[0]);
	const weekEnd = formatDateISO(weekDates[4]);
	const weekEntries = await getEntriesForDateRange(weekStart, weekEnd);
	const weeklyTracked = countTrackedHours(weekEntries);
	const weeklyPercent =
		TARGETS.weeklyTrackableHours > 0
			? Math.round((weeklyTracked / TARGETS.weeklyTrackableHours) * 100)
			: 0;

	return {
		dailyTracked,
		dailyBillable,
		dailyTiers,
		weeklyTracked,
		weeklyPercent,
	};
}

/**
 * renderSidebar
 * Generates the HTML for the stats sidebar.
 *
 * @param {Object} stats - Calculated stats from calculateSidebarStats
 * @returns {string} HTML string
 */
function renderSidebar(stats) {
	/* Determine progress bar color based on weekly compliance */
	let progressClass = "progress-fill-good";
	if (stats.weeklyPercent < TARGETS.compliancePercent) {
		progressClass =
			stats.weeklyPercent < TARGETS.compliancePercent * 0.7
				? "progress-fill-bad"
				: "progress-fill-warn";
	}

	return `
    <!-- Daily tracked hours -->
    <div class="stat-card">
      <div class="stat-card-label">Tracked today</div>
      <div class="stat-card-value">
        ${stats.dailyTracked}
        <span class="text-sm font-normal text-stone-400">/ ${TARGETS.dailyTrackableHours} hrs</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${progressClass}"
             style="width: ${Math.min(100, Math.round((stats.dailyTracked / TARGETS.dailyTrackableHours) * 100))}%"></div>
      </div>
    </div>

    <!-- Weekly tracked hours -->
    <div class="stat-card">
      <div class="stat-card-label">Tracked this week</div>
      <div class="stat-card-value">
        ${stats.weeklyTracked}
        <span class="text-sm font-normal text-stone-400">/ ${TARGETS.weeklyTrackableHours} hrs</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${progressClass}" style="width: ${Math.min(100, stats.weeklyPercent)}%"></div>
      </div>
      <div class="stat-card-sub">${stats.weeklyPercent}% — target ${TARGETS.compliancePercent}%</div>
    </div>

    <!-- Tier breakdown for today -->
    <div class="stat-card">
      <div class="stat-card-label">Tier breakdown today</div>
      <div class="mt-2 space-y-1">
        <div class="flex justify-between text-xs">
          <span class="text-stone-400">Tier 1 (customer)</span>
          <span class="font-medium">${stats.dailyTiers[1]} hrs</span>
        </div>
        <div class="flex justify-between text-xs">
          <span class="text-stone-400">Tier 2 (internal)</span>
          <span class="font-medium">${stats.dailyTiers[2]} hrs</span>
        </div>
        <div class="flex justify-between text-xs">
          <span class="text-stone-400">Tier 3 (other)</span>
          <span class="font-medium">${stats.dailyTiers[3]} hrs</span>
        </div>
      </div>
    </div>

    <!-- Billable today -->
    <div class="stat-card">
      <div class="stat-card-label">Billable today</div>
      <div class="stat-card-value text-emerald-600">
        ${stats.dailyBillable}
        <span class="text-sm font-normal text-stone-400">hrs</span>
      </div>
    </div>

    <!-- Category legend -->
    <div class="mt-4">
      <div class="text-[10px] font-medium text-stone-400 uppercase tracking-wider mb-2">Categories</div>
      ${CATEGORIES.filter((c) => c.id !== "lunch" && c.id !== "other")
				.map(
					(cat) => `
        <div class="flex items-center gap-2 mb-1.5">
          <div class="w-2 h-2 rounded-sm flex-shrink-0" style="background: var(${cat.cssVar})"></div>
          <span class="text-[11px] text-stone-400">${cat.label}</span>
        </div>
      `,
				)
				.join("")}
    </div>
  `;
}

/* ============================================================================
 * EDIT DROPDOWN
 * --------------------------------------------------------------------------
 * When a user clicks a time block, this dropdown appears allowing them
 * to select a category and fill in optional details.
 * ========================================================================= */

/**
 * showEditDropdown
 * Opens the category selection dropdown for a specific time slot.
 *
 * @param {string} slot - The time slot being edited
 * @param {Element} blockEl - The DOM element of the clicked block
 */
function showEditDropdown(slot, blockEl, date = null, onSaveCallback = null) {
	/* Close any existing dropdown first */
	closeDropdown();

	const entry = entries[slot] || {};

	/* Create the dropdown element */
	const dropdown = document.createElement("div");
	dropdown.className = "edit-dropdown";
	dropdown.id = "active-dropdown";

	/* --- Category list --- */
	let html = `
    <!-- Two-column body: categories left, fields right -->
    <div class="dropdown-body">

      <!-- LEFT: Category list -->
      <div class="dropdown-categories">
        ${CATEGORIES.map((cat) => {
					const isSelected = entry.category === cat.id;
					return `
            <div class="dropdown-option ${isSelected ? "selected" : ""}"
                 data-category="${cat.id}">
              <div class="cat-dot" style="background: var(${cat.cssVar})"></div>
              <span>${cat.label}</span>
            </div>
          `;
				}).join("")}
      </div>

      <!-- RIGHT: Detail fields -->
      <div class="detail-panel" id="detail-fields">

        <!-- Sub-category (full width, most used field) -->
        <div>
          <label class="field-label">Sub-category</label>
          <input type="text" id="edit-subcategory"
                 value="${entry.subCategory || ""}"
                 placeholder="e.g., product import, team standup..." />
        </div>

        <!-- Ticket + Merchant/Former POS row -->
        <div class="flex gap-2">
          <div class="flex-1">
            <label class="field-label">Ticket</label>
            <input type="text" id="edit-ticket"
                   value="${entry.ticketLink || ""}"
                   placeholder="URL or #..." />
          </div>
          ${
						appState.settings.enableMerchant
							? `
          <div class="flex-1">
            <label class="field-label">Merchant</label>
            <input type="text" id="edit-merchant"
                   value="${entry.merchant || ""}"
                   placeholder="Merchant name..." />
          </div>
          `
							: ""
					}
          ${
						appState.settings.enableFormerPOS
							? `
          <div class="flex-1">
            <label class="field-label">Former POS</label>
            <input type="text" id="edit-formerpos"
                   value="${entry.formerPOS || ""}"
                   placeholder="Former POS..." />
          </div>
          `
							: ""
					}
        </div>

        <!-- Notes (full width) -->
        <div>
          <label class="field-label">Notes</label>
          <input type="text" id="edit-notes"
                 value="${entry.notes || ""}"
                 placeholder="Any additional context..." />
        </div>

        <!-- Billable + Urgent checkboxes -->
        <div class="flex gap-3 items-center py-1">
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" id="edit-billable"
                   ${entry.billable ? "checked" : ""}
                   class="w-3.5 h-3.5 rounded border-stone-300 text-chronos-500 focus:ring-chronos-300" />
            <span class="text-xs text-stone-500">Billable</span>
          </label>
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" id="edit-urgent"
                   ${entry.urgent ? "checked" : ""}
                   class="w-3.5 h-3.5 rounded border-stone-300 text-red-500 focus:ring-red-300" />
            <span class="text-xs text-stone-500">Urgent</span>
          </label>
        </div>

      </div>
    </div>

    <!-- Full-width button row -->
    <div class="dropdown-buttons">
      <button id="edit-save"
              class="bg-chronos-500 text-white hover:bg-chronos-600">
        Save
      </button>
      <button id="edit-copy"
              class="border border-stone-200 text-stone-500 hover:text-chronos-500 hover:border-chronos-200">
        Copy
      </button>
      ${
				entry.category
					? `
      <button id="edit-clear"
              class="border border-stone-200 text-stone-400 hover:text-red-500 hover:border-red-200">
        Clear
      </button>
      `
					: ""
			}
      <button id="edit-cancel"
              class="border border-stone-200 text-stone-400 hover:text-stone-600">
        Cancel
      </button>
    </div>
  `;

	dropdown.innerHTML = html;

	/* Append to body with fixed positioning to avoid container overflow issues */
	dropdown.style.position = "fixed";
	dropdown.style.visibility = "hidden";
	document.body.appendChild(dropdown);

	/* Measure everything */
	const blockRect = blockEl.getBoundingClientRect();
	const dropdownRect = dropdown.getBoundingClientRect();
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;

	/* Ideal position: directly below the block */
	let left = blockRect.left;
	let top = blockRect.bottom + 4;

	/* Prevent right overflow */
	if (left + dropdownRect.width + 16 > viewportWidth) {
		left = viewportWidth - dropdownRect.width - 16;
	}

	/* Prevent left overflow */
	if (left < 8) {
		left = 8;
	}

	/* If it would go below viewport, show above the block */
	if (top + dropdownRect.height + 16 > viewportHeight) {
		top = blockRect.top - dropdownRect.height - 4;
	}

	/* If still off top, pin to top */
	if (top < 8) {
		top = 8;
	}

	dropdown.style.left = `${left}px`;
	dropdown.style.top = `${top}px`;
	dropdown.style.animation = "none";
	dropdown.style.opacity = "1";
	dropdown.style.visibility = "visible";

	dropdown.style.zIndex = "9999";

	activeDropdown = { element: dropdown, slot };

	/* --- Dropdown event listeners --- */

	/* Category selection: highlight the clicked option */
	let selectedCategory = entry.category || null;
	dropdown.querySelectorAll(".dropdown-option").forEach((opt) => {
		opt.addEventListener("click", () => {
			/* Update visual selection */
			dropdown
				.querySelectorAll(".dropdown-option")
				.forEach((o) => o.classList.remove("selected"));
			opt.classList.add("selected");
			selectedCategory = opt.dataset.category;
		});
	});

	/* Save button */
	dropdown.querySelector("#edit-save").addEventListener("click", async () => {
		if (!selectedCategory) return;

		const newEntry = {
			date: date || formatDateISO(currentDate),
			timeSlot: slot,
			category: selectedCategory,
			subCategory:
				dropdown.querySelector("#edit-subcategory")?.value.trim() || "",
			billable: dropdown.querySelector("#edit-billable")?.checked || false,
			urgent: dropdown.querySelector("#edit-urgent")?.checked || false,
			ticketLink: dropdown.querySelector("#edit-ticket")?.value.trim() || "",
			merchant: dropdown.querySelector("#edit-merchant")?.value.trim() || "",
			formerPOS: dropdown.querySelector("#edit-formerpos")?.value.trim() || "",
			notes: dropdown.querySelector("#edit-notes")?.value.trim() || "",
		};

		await saveEntry(newEntry);
		closeDropdown();
		if (onSaveCallback) {
			await onSaveCallback();
		} else {
			await renderTracker();
		}
	});

	/* Clear button (removes the entry) */
	const clearBtn = dropdown.querySelector("#edit-clear");
	if (clearBtn) {
		clearBtn.addEventListener("click", async () => {
			await deleteEntry(date || formatDateISO(currentDate), slot);
			closeDropdown();
			if (onSaveCallback) {
				await onSaveCallback();
			} else {
				await renderTracker();
			}
		});
	}

	/* Cancel button */
	dropdown.querySelector("#edit-cancel").addEventListener("click", () => {
		closeDropdown();
	});

	/* Copy button */
	dropdown.querySelector("#edit-copy")?.addEventListener("click", () => {
		copyBlock(slot);
		closeDropdown();
	});
}

/**
 * closeDropdown
 * Removes any open edit dropdown from the DOM.
 */
function closeDropdown() {
	if (activeDropdown) {
		activeDropdown.element.remove();
		activeDropdown = null;
	}
	/* Also catch any orphaned dropdowns */
	const orphan = document.getElementById("active-dropdown");
	if (orphan) orphan.remove();
}

/* ============================================================================
 * EVENT LISTENERS
 * --------------------------------------------------------------------------
 * Attaches all interactive event handlers after the tracker renders.
 * ========================================================================= */

function attachEventListeners() {
	/* --- Day navigation arrows --- */
	document.getElementById("prev-day")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		navigateDay(-1);
	});
	document.getElementById("next-day")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		navigateDay(1);
	});

	/* --- "Today" button --- */
	document.getElementById("btn-today")?.addEventListener("click", () => {
		currentDate = new Date();
		weekDates = getWeekDates(currentDate);
		renderTracker();
	});

	/* --- Week day chips --- */
	document.querySelectorAll(".week-chip").forEach((chip) => {
		chip.addEventListener("click", () => {
			closeDropdown();
			closeWeekPopover();
			currentDate = parseDate(chip.dataset.date);
			renderTracker();
		});
	});

	/* --- Fill lunch button --- */
	document
		.getElementById("btn-fill-lunch")
		?.addEventListener("click", async () => {
			await fillLunch();
		});

	/* View toggle */
	document.getElementById("toggle-day")?.addEventListener("click", () => {
		activeView = "day";
		renderTracker();
	});
	document.getElementById("toggle-week")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		activeView = "week";
		renderWeekView();
	});

	document.getElementById("toggle-notes")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		activeView = "notes";
		renderNotesView();
	});

	/* --- Time block clicks --- */
	document
		.querySelectorAll(".time-block-empty, .time-block-filled")
		.forEach((block) => {
			block.addEventListener("click", async (e) => {
				/* Don't trigger if clicking inside an open dropdown */
				if (e.target.closest(".edit-dropdown")) return;

				if (activeDropdown) {
					closeDropdown();
					return;
				}

				const slot = block.dataset.slot;
				/* Determine which date this block belongs to
				 * (needed for week view where blocks span multiple days) */
				const date = block.dataset.date || formatDateISO(currentDate);

				/* SHIFT+CLICK: Range fill from last clicked block */
				if (isShiftDown && lastClickedSlot && entries[lastClickedSlot]) {
					await fillRange(lastClickedSlot, slot, date);
					await renderTracker();
					return;
				}

				/* CLIPBOARD PASTE: If clipboard has data and block is empty, paste */
				if (clipboard && !entries[slot]) {
					await pasteBlock(date, slot);
					await renderTracker();
					return;
				}

				/* NORMAL CLICK: Open the edit dropdown */
				showEditDropdown(slot, block);
				lastClickedSlot = slot;
			});
		});
}

/**
 * attachWeekEventListeners
 * Event handlers specific to the week view.
 */
function attachWeekEventListeners() {
	/* View toggle buttons */
	document.getElementById("toggle-day")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		activeView = "day";
		renderTracker();
	});
	document.getElementById("toggle-week")?.addEventListener("click", () => {
		activeView = "week";
		renderWeekView();
	});

	document.getElementById("toggle-notes")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		activeView = "notes";
		renderNotesView();
	});

	/* Week navigation */
	document.getElementById("prev-week")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		const mon = weekDates[0];
		mon.setDate(mon.getDate() - 7);
		weekDates = getWeekDates(mon);
		currentDate = weekDates[0];
		renderWeekView();
	});
	document.getElementById("next-week")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		const mon = weekDates[0];
		mon.setDate(mon.getDate() + 7);
		weekDates = getWeekDates(mon);
		currentDate = weekDates[0];
		renderWeekView();
	});

	/* Week day chips — switch to day view for that date */
	document.querySelectorAll(".week-chip").forEach((chip) => {
		chip.addEventListener("click", () => {
			closeDropdown();
			closeWeekPopover();
			currentDate = parseDate(chip.dataset.date);
			activeView = "day";
			renderTracker();
		});
	});

	/* Block clicks */
	document.querySelectorAll(".week-block").forEach((block) => {
		block.addEventListener("click", async (e) => {
			if (e.target.closest(".week-popover")) return;
			if (e.target.closest(".edit-dropdown")) return;

			/* If a dropdown is already open, close it and stop — don't open a new one */
			if (activeDropdown) {
				closeDropdown();
				return;
			}

			const slot = block.dataset.slot;
			const date = block.dataset.date;

			if (block.classList.contains("time-block-filled")) {
				/* Filled block: show detail popover */
				const dayEntries = await getEntriesForDate(date);
				const entry = dayEntries.find((e) => e.timeSlot === slot);
				if (entry) {
					showWeekPopover(entry, block);
				}
				return;
			}

			if (block.classList.contains("time-block-empty")) {
				/* Empty block with clipboard: paste */
				if (clipboard) {
					await pasteBlock(date, slot);
					await renderWeekView();
					return;
				}

				/* Empty block without clipboard: open edit dropdown */
				closeWeekPopover();
				showEditDropdown(slot, block, date, renderWeekView);
				return;
			}
		});

		/* Double-click: jump to day view for that date */
		block.addEventListener("dblclick", () => {
			const date = block.dataset.date;
			currentDate = parseDate(date);
			activeView = "day";
			renderTracker();
		});
	});
}

/* ============================================================================
 * CLIPBOARD OPERATIONS
 * ========================================================================= */

/**
 * copyBlock
 * Copies a time entry's data to the clipboard (strips date and timeSlot
 * since those change when pasting to a different location).
 *
 * @param {string} slot - The time slot of the block to copy
 */
function copyBlock(slot) {
	const entry = entries[slot];
	if (!entry) return;

	/* Store everything except the positional data */
	clipboard = {
		category: entry.category,
		subCategory: entry.subCategory || "",
		billable: entry.billable || false,
		merchant: entry.merchant || "",
		urgent: entry.urgent || false,
		ticketLink: entry.ticketLink || "",
		formerPOS: entry.formerPOS || "",
		notes: entry.notes || "",
	};

	lastClickedSlot = slot;
	updateClipboardIndicator();
}

/**
 * pasteBlock
 * Pastes the clipboard data into a specific date and time slot.
 *
 * @param {string} date - Target date in 'YYYY-MM-DD' format
 * @param {string} slot - Target time slot, e.g., '09:00'
 */
async function pasteBlock(date, slot) {
	if (!clipboard) return;

	await saveEntry({
		date,
		timeSlot: slot,
		...clipboard,
	});
}

/**
 * fillRange
 * Fills all blocks between two time slots (inclusive) on the current day
 * with the data from the anchor block. Used for shift+click.
 *
 * @param {string} fromSlot - Start time slot
 * @param {string} toSlot   - End time slot
 * @param {string} date     - The date to fill on
 */
async function fillRange(fromSlot, toSlot, date) {
	const source = entries[fromSlot];
	if (!source) return;

	/* Determine the range bounds (in case user shift-clicks upward) */
	const fromIdx = timeSlots.indexOf(fromSlot);
	const toIdx = timeSlots.indexOf(toSlot);
	const startIdx = Math.min(fromIdx, toIdx);
	const endIdx = Math.max(fromIdx, toIdx);

	/* Fill every slot in the range */
	for (let i = startIdx; i <= endIdx; i++) {
		await saveEntry({
			date,
			timeSlot: timeSlots[i],
			category: source.category,
			subCategory: source.subCategory || "",
			billable: source.billable || false,
			merchant: source.merchant || "",
			urgent: source.urgent || false,
			ticketLink: source.ticketLink || "",
			formerPOS: source.formerPOS || "",
			notes: source.notes || "",
		});
	}
}

/**
 * updateClipboardIndicator
 * Shows or hides the floating clipboard status bar at the top of the grid.
 */
function updateClipboardIndicator() {
	const existing = document.getElementById("clipboard-indicator");
	if (existing) existing.remove();

	if (!clipboard) return;

	const cat = CATEGORIES.find((c) => c.id === clipboard.category);
	const label = cat ? cat.label : clipboard.category;

	const indicator = document.createElement("div");
	indicator.id = "clipboard-indicator";
	indicator.className = "clipboard-indicator";
	indicator.innerHTML = `
    <div class="flex items-center gap-2">
      <div class="w-2 h-2 rounded-sm" style="background: var(${cat.cssVar}) || "var(--cat-other-border)"}"></div>
      <span class="text-xs font-medium text-chronos-700">Copied: ${label}</span>
      ${clipboard.subCategory ? `<span class="text-xs text-chronos-400">— ${clipboard.subCategory}</span>` : ""}
    </div>
    <button id="clipboard-clear" class="text-xs text-chronos-400 hover:text-chronos-600">
      Clear (Esc)
    </button>
  `;

	/* Insert at the top of the time grid */
	const grid = document.getElementById("time-grid");
	if (grid) grid.prepend(indicator);

	/* Clear button listener */
	document.getElementById("clipboard-clear")?.addEventListener("click", () => {
		clipboard = null;
		updateClipboardIndicator();
	});
}

/* ============================================================================
 * DAY NAVIGATION
 * ========================================================================= */

/**
 * navigateDay
 * Moves the current date forward or backward by one day (weekdays only).
 *
 * @param {number} direction - +1 for next day, -1 for previous day
 */
function navigateDay(direction) {
	const newDate = new Date(currentDate);
	newDate.setDate(newDate.getDate() + direction);

	/* Skip weekends */
	const day = newDate.getDay();
	if (day === 0) newDate.setDate(newDate.getDate() + (direction > 0 ? 1 : -2)); // Sunday
	if (day === 6) newDate.setDate(newDate.getDate() + (direction > 0 ? 2 : -1)); // Saturday

	currentDate = newDate;

	/* Update week dates if we've moved to a different week */
	const newWeekDates = getWeekDates(currentDate);
	if (formatDateISO(newWeekDates[0]) !== formatDateISO(weekDates[0])) {
		weekDates = newWeekDates;
	}

	renderTracker();
}

/* ============================================================================
 * WEEK VIEW
 * --------------------------------------------------------------------------
 * Shows Mon-Fri as 5 columns with time slots as rows.
 * Blocks are clickable for editing. Clipboard paste works across days.
 * ========================================================================= */

/**
 * renderWeekView
 * Builds the 5-column week grid and inserts it into the tracker container.
 */
async function renderWeekView() {
	const container = document.getElementById("view-tracker");

	/* Load entries for all 5 days */
	const weekStart = formatDateISO(weekDates[0]);
	const weekEnd = formatDateISO(weekDates[4]);
	const weekEntries = await getEntriesForDateRange(weekStart, weekEnd);

	/* Build a lookup: date → timeSlot → entry */
	const weekData = {};
	weekDates.forEach((d) => {
		weekData[formatDateISO(d)] = {};
	});
	weekEntries.forEach((e) => {
		if (!weekData[e.date]) weekData[e.date] = {};
		weekData[e.date][e.timeSlot] = e;
	});

	/* Calculate weekly stats for sidebar */
	const sidebarStats = await calculateSidebarStats();

	container.innerHTML = `
    <!-- Week navigation (same as day view but with week context) -->
    <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
            <button id="prev-week" class="w-8 h-8 flex items-center justify-center rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 hover:border-stone-300 transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
                </svg>
            </button>
            <span class="text-sm font-medium min-w-[200px] text-center">
                Week of ${formatDateDisplay(weekDates[0])}
            </span>
            <button id="next-week" class="w-8 h-8 flex items-center justify-center rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 hover:border-stone-300 transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                </svg>
            </button>
        </div>

		<!-- View toggle -->
		<div class="flex gap-1 bg-surface-100 rounded-lg p-0.5">
		<button id="toggle-day" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
			${activeView === "day" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Day</button>
		<button id="toggle-week" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
			${activeView === "week" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Week</button>
		<button id="toggle-notes" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
			${activeView === "notes" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Notes</button>
		</div>
    </div>

    <!-- Clipboard indicator mounts here -->
    <div id="clipboard-mount"></div>

	<!-- Week day chips (matches day view) -->
	<div class="flex gap-1 mb-4" style="padding-left: 56px; padding-right: calc(224px + 24px);">
	${weekDates
		.map((d) => {
			const isToday = formatDateISO(d) === formatDateISO(new Date());
			return `
		<button class="week-chip flex-1 py-2 text-center text-xs rounded-lg transition-colors
			${
				isToday
					? "active-chip text-chronos-600 font-medium"
					: "bg-surface-100 text-stone-400 hover:bg-surface-200"
			}"
			data-date="${formatDateISO(d)}">
			${formatDateShort(d)}
		</button>
		`;
		})
		.join("")}
	</div>

    <!-- Week grid -->
    <div class="flex gap-6">
      <div class="flex-1 overflow-x-auto" id="time-grid">
        <div class="week-grid">

          <!-- Time rows -->
          ${timeSlots
						.map(
							(slot) => `
            <div class="week-grid-row">
              <!-- Time label -->
              <div class="w-14 flex-shrink-0 text-[10px] text-stone-400 pt-1 select-none">
                ${formatTimeSlot(slot)}
              </div>
              <!-- 5 day columns -->
              ${weekDates
								.map((d) => {
									const dateStr = formatDateISO(d);
									const dayData = weekData[dateStr] || {};
									const entry = dayData[slot];
									const cat =
										entry && entry.category
											? CATEGORIES.find((c) => c.id === entry.category)
											: null;

									if (entry && entry.category) {
										return `
                    <div class="flex-1 week-block time-block-filled cat-${entry.category} rounded-sm mx-0.5 cursor-pointer relative group"
                        data-slot="${slot}" data-date="${dateStr}">
                      <span class="week-block-label">${cat?.label || ""}</span>
                      ${entry.subCategory ? `<span class="week-block-sub">${entry.subCategory}</span>` : ""}
                      <div class="absolute top-0.5 right-1 flex items-center gap-1">
                        ${entry.billable ? '<span class="text-[8px] text-emerald-500">$</span>' : ""}
                        ${entry.urgent ? '<span class="w-1 h-1 rounded-full bg-red-400 inline-block"></span>' : ""}
                      </div>
                    </div>
                  `;
									} else {
										return `
                    <div class="flex-1 week-block time-block-empty rounded-sm mx-0.5 cursor-pointer"
                        data-slot="${slot}" data-date="${dateStr}">
                    </div>
                  `;
									}
								})
								.join("")}
            </div>
          `,
						)
						.join("")}
        </div>
      </div>

      <!-- Sidebar (same stats) -->
      <div class="w-56 flex-shrink-0 space-y-3">
        ${renderSidebar(sidebarStats)}
      </div>
    </div>
  `;

	/* Re-show clipboard indicator if active */
	if (clipboard) updateClipboardIndicator();

	/* Attach week view event listeners */
	attachWeekEventListeners();
}

/* ============================================================================
 * NOTES VIEW
 * --------------------------------------------------------------------------
 * Weekly qualitative notes: wins, losses, issues to flag, and customer
 * meetings. Saved per ISO week and included in exports.
 * ========================================================================= */

/**
 * renderNotesView
 * Builds the notes form for the current week.
 */
async function renderNotesView() {
	const container = document.getElementById("view-tracker");
	const weekKey = getISOWeekKey(currentDate);

	/* Load existing notes for this week */
	const existing = await getWeeklyNotes(weekKey);
	const notes = existing || {
		wins: "",
		losses: "",
		issues: "",
		customerMeetings: "",
	};

	container.innerHTML = `
    <!-- Week navigation -->
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-3">
        <button id="prev-week" class="w-8 h-8 flex items-center justify-center rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 hover:border-stone-300 transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
        </button>
        <span class="text-sm font-medium min-w-[200px] text-center">
          Week of ${formatDateDisplay(weekDates[0])}
        </span>
        <button id="next-week" class="w-8 h-8 flex items-center justify-center rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 hover:border-stone-300 transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>
      </div>

      <!-- View toggle -->
      <div class="flex gap-1 bg-surface-100 rounded-lg p-0.5">
        <button id="toggle-day" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
          ${activeView === "day" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Day</button>
        <button id="toggle-week" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
          ${activeView === "week" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Week</button>
        <button id="toggle-notes" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
          ${activeView === "notes" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Notes</button>
      </div>
    </div>

    <!-- Notes form -->
    <div class="max-w-2xl">

      <!-- Auto-save indicator -->
      <div id="notes-save-status" class="text-xs text-stone-300 mb-4 h-4"></div>

      <!-- Wins -->
      <div class="mb-6">
        <label class="block text-sm font-medium text-stone-700 mb-1.5">Wins of the week</label>
        <p class="text-xs text-stone-400 mb-2">What went well? Successful migrations, resolved tickets, shipped features, positive customer feedback.</p>
        <textarea id="notes-wins"
                  rows="4"
                  placeholder="e.g., Successfully helped migrate Merchant X to new POS, resolved high-priority ticket #1234..."
                  class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 bg-surface-50 focus:ring-2 focus:ring-chronos-300 focus:border-chronos-300 resize-y"
        >${notes.wins || ""}</textarea>
      </div>

      <!-- Losses -->
      <div class="mb-6">
        <label class="block text-sm font-medium text-stone-700 mb-1.5">Losses of the week</label>
        <p class="text-xs text-stone-400 mb-2">What didn't go as planned? Blockers, delays, things that took longer than expected.</p>
        <textarea id="notes-losses"
                  rows="4"
                  placeholder="e.g., [merchant] churned due to [issue] that we couldn't resolve in time..."
                  class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 bg-surface-50 focus:ring-2 focus:ring-chronos-300 focus:border-chronos-300 resize-y"
        >${notes.losses || ""}</textarea>
      </div>

      <!-- Issues to flag -->
      <div class="mb-6">
        <label class="block text-sm font-medium text-stone-700 mb-1.5">Issues to flag to management</label>
        <p class="text-xs text-stone-400 mb-2">Recurring problems, resource constraints, customer patterns, high-capacity situations that need attention.</p>
        <textarea id="notes-issues"
                  rows="4"
                  placeholder="e.g., LSR-1234 causing reoccurring issues for merchants, leading to high ticket volume..."
                  class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 bg-surface-50 focus:ring-2 focus:ring-chronos-300 focus:border-chronos-300 resize-y"
        >${notes.issues || ""}</textarea>
      </div>
    </div>
  `;

	/* Attach notes event listeners */
	attachNotesListeners();
}

/**
 * attachNotesListeners
 * Sets up auto-save on notes fields and navigation handlers.
 */
function attachNotesListeners() {
	const statusEl = document.getElementById("notes-save-status");

	/* Debounced auto-save for all textareas */
	let saveTimeout;
	const autoSave = async () => {
		const weekKey = getISOWeekKey(currentDate);

		const notesData = {
			wins: document.getElementById("notes-wins")?.value || "",
			losses: document.getElementById("notes-losses")?.value || "",
			issues: document.getElementById("notes-issues")?.value || "",
			customerMeetings: document.getElementById("notes-meetings")?.value || "",
		};

		await saveWeeklyNotes(weekKey, notesData);

		/* Show save confirmation */
		if (statusEl) {
			statusEl.textContent = "Saved";
			statusEl.style.color = "var(--positive)";
			setTimeout(() => {
				if (statusEl) {
					statusEl.textContent = "";
				}
			}, 2000);
		}
	};

	/* Attach to all textareas with debounce */
	document.querySelectorAll("#view-tracker textarea").forEach((textarea) => {
		textarea.addEventListener("input", () => {
			/* Show "saving..." while debouncing */
			if (statusEl) {
				statusEl.textContent = "Saving...";
				statusEl.style.color = "var(--cat-lunch-text)";
			}
			clearTimeout(saveTimeout);
			saveTimeout = setTimeout(autoSave, 500);
		});
	});

	/* View toggles */
	document.getElementById("toggle-day")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		activeView = "day";
		renderTracker();
	});
	document.getElementById("toggle-week")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		activeView = "week";
		renderWeekView();
	});
	document.getElementById("toggle-notes")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		activeView = "notes";
		renderNotesView();
	});

	/* Week navigation */
	document.getElementById("prev-week")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		const mon = weekDates[0];
		mon.setDate(mon.getDate() - 7);
		weekDates = getWeekDates(mon);
		currentDate = weekDates[0];
		renderNotesView();
	});
	document.getElementById("next-week")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		const mon = weekDates[0];
		mon.setDate(mon.getDate() + 7);
		weekDates = getWeekDates(mon);
		currentDate = weekDates[0];
		renderNotesView();
	});
}

/**
 * showWeekPopover
 * Shows a detail popover when clicking a filled block in week view.
 * Displays full entry info with Copy, Edit (go to day), and Clear actions.
 *
 * @param {Object} entry   - The time entry data
 * @param {Element} blockEl - The clicked block element
 */
function showWeekPopover(entry, blockEl) {
	/* Close any existing popover */
	closeWeekPopover();

	const cat = CATEGORIES.find((c) => c.id === entry.category);
	const tierMap = appState.tierMap || {};
	const tierNum = tierMap[entry.category] || 3;
	const tierLabel =
		tierNum === 1
			? "Tier 1 — Customer"
			: tierNum === 2
				? "Tier 2 — Internal"
				: "Tier 3 — Other";

	const popover = document.createElement("div");
	popover.className = "week-popover";
	popover.id = "week-popover";

	let html = `
    <!-- Category header -->
    <div class="flex items-center gap-2 mb-2 pb-2 border-b border-stone-100">
      <div class="w-2.5 h-2.5 rounded-sm" style="background: var(${cat.cssVar}) || "var(--cat-other-border)"}"></div>
      <span class="text-sm font-medium">${cat?.label || entry.category}</span>
    </div>

    <!-- Details -->
    <div class="space-y-1 mb-3">
      <div class="week-popover-row">
        <span class="week-popover-label">Time</span>
        <span class="week-popover-value">${formatTimeSlot(entry.timeSlot)}</span>
      </div>
      <div class="week-popover-row">
        <span class="week-popover-label">Tier</span>
        <span class="week-popover-value">${tierLabel}</span>
      </div>
  `;

	/* Only show optional fields if they have values */
	if (entry.subCategory) {
		html += `
      <div class="week-popover-row">
        <span class="week-popover-label">Sub-category</span>
        <span class="week-popover-value">${entry.subCategory}</span>
      </div>
    `;
	}
	if (entry.merchant) {
		html += `
      <div class="week-popover-row">
        <span class="week-popover-label">Merchant</span>
        <span class="week-popover-value">${entry.merchant}</span>
      </div>
    `;
	}
	if (entry.ticketLink) {
		html += `
      <div class="week-popover-row">
        <span class="week-popover-label">Ticket</span>
        <span class="week-popover-value text-blue-500">${entry.ticketLink}</span>
      </div>
    `;
	}
	if (entry.notes) {
		html += `
      <div class="week-popover-row">
        <span class="week-popover-label">Notes</span>
        <span class="week-popover-value">${entry.notes}</span>
      </div>
    `;
	}

	html += `
      <div class="week-popover-row">
        <span class="week-popover-label">Billable</span>
        <span class="week-popover-value">${entry.billable ? "Yes" : "No"}</span>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="flex gap-2">
      <button id="popover-copy"
              class="flex-1 text-xs py-1.5 rounded-lg bg-chronos-100 text-chronos-600 font-medium hover:bg-chronos-200 transition-colors">
        Copy
      </button>
      <button id="popover-edit"
              class="flex-1 text-xs py-1.5 rounded-lg border border-stone-200 text-stone-500 hover:text-stone-700 transition-colors">
        Edit
      </button>
      <button id="popover-clear"
              class="text-xs py-1.5 px-3 rounded-lg border border-stone-200 text-stone-400 hover:text-red-500 hover:border-red-200 transition-colors">
        Clear
      </button>
    </div>
  `;

	popover.innerHTML = html;

	/* Append to body with fixed positioning */
	popover.style.position = "fixed";
	popover.style.visibility = "hidden";
	document.body.appendChild(popover);

	/* Measure everything */
	const blockRect = blockEl.getBoundingClientRect();
	const popoverRect = popover.getBoundingClientRect();
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;

	/* Ideal position: below the block */
	let left = blockRect.left;
	let top = blockRect.bottom + 4;

	/* Prevent right overflow */
	if (left + popoverRect.width + 16 > viewportWidth) {
		left = viewportWidth - popoverRect.width - 16;
	}

	/* Prevent left overflow */
	if (left < 8) {
		left = 8;
	}

	/* Flip above if below viewport */
	if (top + popoverRect.height + 16 > viewportHeight) {
		top = blockRect.top - popoverRect.height - 4;
	}

	/* Pin to top if needed */
	if (top < 8) {
		top = 8;
	}

	popover.style.left = `${left}px`;
	popover.style.top = `${top}px`;
	popover.style.visibility = "visible";
	popover.style.zIndex = "9999";

	/* --- Button listeners --- */

	/* Copy: put entry data on clipboard */
	popover.querySelector("#popover-copy").addEventListener("click", (e) => {
		e.stopPropagation();
		clipboard = {
			category: entry.category,
			subCategory: entry.subCategory || "",
			billable: entry.billable || false,
			merchant: entry.merchant || "",
			urgent: entry.urgent || false,
			ticketLink: entry.ticketLink || "",
			formerPOS: entry.formerPOS || "",
			notes: entry.notes || "",
		};
		updateClipboardIndicator();
		closeWeekPopover();
	});

	/* Edit: edit in the week view directly */
	popover.querySelector("#popover-edit").addEventListener("click", (e) => {
		e.stopPropagation();
		e.preventDefault();
		closeWeekPopover();
		/* Open the edit dropdown right here in week view */
		showEditDropdown(entry.timeSlot, blockEl, entry.date, renderWeekView);
	});

	/* Clear: delete the entry */
	popover
		.querySelector("#popover-clear")
		.addEventListener("click", async (e) => {
			e.stopPropagation();
			await deleteEntry(entry.date, entry.timeSlot);
			closeWeekPopover();
			await renderWeekView();
		});
}

/**
 * closeWeekPopover
 * Removes any open week detail popover.
 */
function closeWeekPopover() {
	const existing = document.getElementById("week-popover");
	if (existing) existing.remove();
}

/* ============================================================================
 * QUICK ACTIONS
 * ========================================================================= */

/**
 * fillLunch
 * Auto-fills the lunch time blocks based on user settings.
 * Uses the configured lunch start time and number of blocks.
 */
async function fillLunch() {
	const lunchStart =
		appState.settings.lunchStartHour || TIME_DEFAULTS.lunchStartHour;
	const lunchBlocks =
		appState.settings.lunchBlocks || TIME_DEFAULTS.lunchBlocks;
	const dateStr = formatDateISO(currentDate);

	/* Generate the lunch time slots */
	for (let i = 0; i < lunchBlocks; i++) {
		const hour = lunchStart + Math.floor((i * 30) / 60);
		const minute = (i * 30) % 60;
		const slot = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

		await saveEntry({
			date: dateStr,
			timeSlot: slot,
			category: "lunch",
			subCategory: "",
			billable: false,
			urgent: false,
			ticketLink: "",
			merchant: "",
			formerPOS: "",
			notes: "",
		});
	}

	/* Re-render to show the filled lunch blocks */
	await renderTracker();
}
