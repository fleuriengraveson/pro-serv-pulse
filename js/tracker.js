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
	getUniqueFieldValues,
	getLastEntryForMerchant,
	getAllTeamNotesForWeek,
	getTeamMemberNotes,
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
	filterEntriesUpToNow,
	countExpectedHoursUpToNow,
	isToday,
	isFutureDate,
	countOOOHours,
	countOOODays,
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
let activeView = localStorage.getItem("chronos-tracker-view") || "day";
if (activeView === "notes") activeView = "day";

function setActiveView(view) {
	/* Notes is now a panel, not a view — don't persist it */
	if (view === "notes") return;
	activeView = view;
	localStorage.setItem("chronos-tracker-view", view);
}

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
			const oooPopover = document.getElementById("ooo-popover");
			if (oooPopover) {
				closeOOOPopover();
				return;
			}
			return;
		}
		if (clipboard) {
			clipboard = null;
			updateClipboardIndicator();
		}
	}
	/* Enter saves the active dropdown if one is open */
	if (e.key === "Enter" && activeDropdown) {
		/* Don't save if an autocomplete list is open with a selected item */
		const autocompleteOpen = document.querySelector(
			".autocomplete-list .autocomplete-item.active",
		);
		if (autocompleteOpen) return;

		e.preventDefault();
		const saveBtn = document.querySelector("#edit-save");
		if (saveBtn) {
			saveBtn.click();
		}
	}

	if (!isTyping && !e.ctrlKey && !e.metaKey && !e.altKey) {
		/* Stats period shortcuts — only when stats view is active */
		const statsVisible = !document
			.getElementById("view-stats")
			?.classList.contains("hidden");
		if (statsVisible) {
			const periodKeys = {
				w: "weekly",
				W: "weekly",
				m: "monthly",
				M: "monthly",
				q: "quarterly",
				Q: "quarterly",
				f: "fy",
				F: "fy",
				y: "cy",
				Y: "cy",
			};
			if (periodKeys[e.key]) {
				e.preventDefault();
				const chip = document.querySelector(
					`.period-chip[data-period="${periodKeys[e.key]}"]`,
				);
				if (chip) chip.click();
				return;
			}
		}

		/* Tracker shortcuts below only apply when stats is NOT active */
		if (e.key === "d" || e.key === "D") {
			closeDropdown();
			closeWeekPopover();
			closeOOOPopover();
			setActiveView("day");
			renderTracker();
		}
		if (e.key === "w" || e.key === "W") {
			closeDropdown();
			closeWeekPopover();
			closeOOOPopover();
			setActiveView("week");
			renderWeekView();
		}
		if (e.key === "n" || e.key === "N") {
			closeDropdown();
			closeWeekPopover();
			closeOOOPopover();
			/* If stats page notes button exists, use it (passes correct state) */
			const statsNotesBtn = document.getElementById("stats-notes-btn");
			if (statsNotesBtn) {
				statsNotesBtn.click();
			} else {
				showNotesPanel();
			}
		}
		if (e.key === "t" || e.key === "T") {
			closeDropdown();
			closeWeekPopover();
			closeOOOPopover();
			document.querySelector('.nav-btn[data-view="tracker"]')?.click();
		}
		if (e.key === "s" || e.key === "S") {
			closeDropdown();
			closeWeekPopover();
			closeOOOPopover();
			document.querySelector('.nav-btn[data-view="stats"]')?.click();
		}
		if (e.key === "ArrowLeft") {
			e.preventDefault();
			closeDropdown();
			closeWeekPopover();
			closeOOOPopover();
			if (activeView === "day") {
				navigateDay(-1);
			} else if (activeView === "week" || activeView === "notes") {
				const mon = weekDates[0];
				mon.setDate(mon.getDate() - 7);
				weekDates = getWeekDates(mon);
				currentDate = weekDates[0];
				if (activeView === "week") renderWeekView();
				else renderNotesView();
			}
		}
		if (e.key === "ArrowRight") {
			e.preventDefault();
			closeDropdown();
			closeWeekPopover();
			closeOOOPopover();
			if (activeView === "day") {
				navigateDay(1);
			} else if (activeView === "week" || activeView === "notes") {
				const mon = weekDates[0];
				mon.setDate(mon.getDate() + 7);
				weekDates = getWeekDates(mon);
				currentDate = weekDates[0];
				if (activeView === "week") renderWeekView();
				else renderNotesView();
			}
		}
	}
});
document.addEventListener("keyup", (e) => {
	if (e.key === "Shift") isShiftDown = false;
});

/* Global click-outside handler — runs once, handles both views */
document.addEventListener("click", (e) => {
	/* Always close OOO popover when clicking outside it */
	if (!e.target.closest(".ooo-popover")) {
		closeOOOPopover();
	}

	/* Ignore clicks inside dropdowns and popovers */
	if (e.target.closest(".edit-dropdown")) return;
	if (e.target.closest(".week-popover")) return;
	if (e.target.closest(".ooo-popover")) return;

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
	closeOOOPopover();
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

	/* Preserve scroll position across re-renders */
	const existingGrid = document.querySelector(".tracker-grid");
	const savedScroll = existingGrid ? existingGrid.scrollTop : 0;

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
        <div class="tracker-nav">
    <div class="flex items-center justify-between mb-2">
      <div class="flex items-center gap-3">
        <button id="prev-day" class="w-8 h-8 flex items-center justify-center rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 hover:border-stone-300 transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
        </button>
        <span id="current-date" class="text-sm font-medium min-w-[200px] text-center">
          Week of ${formatDateDisplay(weekDates[0])}
        </span>
        <button id="next-day" class="w-8 h-8 flex items-center justify-center rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 hover:border-stone-300 transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>
      </div>

      <div class="flex items-center gap-3">
        <!-- View toggle -->
        <div class="flex gap-1 bg-surface-100 rounded-lg p-0.5">
          <button id="toggle-day" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
            ${activeView === "day" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Day (D)</button>
          <button id="toggle-week" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
            ${activeView === "week" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Week (W)</button>
        </div>
      </div>
    </div>
    </div>

    <!-- Week day chips -->
	<div class="tracker-chips">
    <div class="flex gap-1" style="padding-left: 56px; padding-right: calc(224px + 24px);">
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
	</div>

    <!-- ================================================================
        MAIN CONTENT: TIME GRID + SIDEBAR
	================================================================ -->
    <div class="tracker-content">

      <!-- Time grid (left, scrollable) -->
      <div class="tracker-grid" id="time-grid">
            ${timeSlots.map((slot) => renderTimeBlock(slot)).join("")}
        </div>

		<!-- Sidebar stats (right, sticky) -->
      <div class="tracker-sidebar space-y-3">
			${renderSidebar(sidebarStats)}
		</div>

    </div>
    `;

	/* Attach event listeners after rendering */
	attachEventListeners();

	/* Re-show clipboard indicator if clipboard is active */
	if (clipboard) updateClipboardIndicator();

	/* Restore scroll position */
	const newGrid = document.querySelector(".tracker-grid");
	if (newGrid) newGrid.scrollTop = savedScroll;
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
      <div class="time-row flex items-stretch border-b relative" style="border-color: var(--border-subtle);"
           data-slot="${slot}">
        <!-- Time label -->
        <div class="w-14 flex-shrink-0 pt-2.5 text-xs text-stone-400 select-none">
          ${formatTimeSlot(slot)}
        </div>
        <!-- Filled block content -->
        <div class="flex-1 time-block-filled cat-${entry.category} rounded-md px-3 py-2 my-0.5 flex items-center gap-2 min-h-[40px]"
             data-slot="${slot}" style="position: relative;">
          <span class="text-xs font-medium ${isLunch ? "text-stone-400" : "text-stone-700"}">${label}</span>
          ${entry.merchant || entry.subCategory ? `<span class="text-xs text-stone-400">${[entry.merchant, entry.subCategory].filter(Boolean).join(" — ")}</span>` : ""}
          <div class="ml-auto flex items-center gap-2">
            ${entry.urgent ? '<span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>' : ""}
            ${entry.billable ? '<span class="text-[10px] font-medium text-emerald-500">$</span>' : ""}
            ${entry.ticketLink ? `<a href="${entry.ticketLink}" target="_blank" rel="noopener" class="text-[10px] text-blue-400 hover:underline" onclick="event.stopPropagation();">#${entry.ticketLink.split("/").pop()}</a>` : ""}
          </div>
          ${
						entry.category !== "lunch" && entry.category !== "ooo"
							? `
          <div class="block-tooltip">
            <div class="tooltip-header">
              <div class="w-2 h-2 rounded-sm" style="background: var(${cat ? cat.cssVar : "--cat-other-border"})"></div>
              ${label}
            </div>
            ${entry.subCategory ? `<div class="tooltip-row"><span class="tooltip-label">Sub-category</span><span class="tooltip-value">${entry.subCategory}</span></div>` : ""}
            ${entry.merchant ? `<div class="tooltip-row"><span class="tooltip-label">Merchant</span><span class="tooltip-value">${entry.merchant}</span></div>` : ""}
            ${entry.formerPOS ? `<div class="tooltip-row"><span class="tooltip-label">Former POS</span><span class="tooltip-value">${entry.formerPOS}</span></div>` : ""}
            ${entry.ticketLink ? `<div class="tooltip-row"><span class="tooltip-label">Ticket</span><span class="tooltip-value">#${entry.ticketLink.split("/").pop()}</span></div>` : ""}
            ${entry.notes ? `<div class="tooltip-row"><span class="tooltip-label">Notes</span><span class="tooltip-value">${entry.notes}</span></div>` : ""}
            <div class="tooltip-row"><span class="tooltip-label">Billable</span><span class="tooltip-value">${entry.billable ? "Yes" : "No"}</span></div>
            ${entry.urgent ? `<div class="tooltip-row"><span class="tooltip-label">Urgent</span><span class="tooltip-value" style="color: var(--danger);">Yes</span></div>` : ""}
          </div>
          `
							: ""
					}
        </div>
      </div>
    `;
	} else {
		/* --- EMPTY BLOCK --- */
		return `
      <div class="time-row flex items-stretch border-b relative" style="border-color: var(--border-subtle);"
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

	const weekStart = formatDateISO(weekDates[0]);
	const weekEnd = formatDateISO(weekDates[4]);
	const weekEntries = await getEntriesForDateRange(weekStart, weekEnd);
	const oooDates = getOOODatesFromEntries(weekEntries);

	/* --- Daily stats --- */
	const dayEntries = Object.values(entries).filter((e) => e.category);
	/* For today, only count blocks up to the current time */
	const currentDateStr = formatDateISO(currentDate);
	const relevantDayEntries = isToday(currentDateStr)
		? filterEntriesUpToNow(dayEntries)
		: dayEntries;
	const dailyTracked = countTrackedHours(relevantDayEntries);
	const dailyBillable = countBillableHours(relevantDayEntries);
	const dailyTiers = aggregateByTier(relevantDayEntries, tierMap);

	/* Daily expected hours — for today, only up to current time */
	const startHour = appState.settings.dayStartHour || 8;
	const dailyIsOOO = oooDates.has(currentDateStr);
	const dailyExpected = dailyIsOOO
		? 0
		: isFutureDate(currentDateStr)
			? 0
			: isToday(currentDateStr)
				? countExpectedHoursUpToNow(
						currentDateStr,
						currentDateStr,
						TARGETS.dailyTrackableHours,
						oooDates,
						startHour,
					)
				: TARGETS.dailyTrackableHours;

	/* --- Weekly stats --- */
	const relevantWeekEntries = filterEntriesUpToNow(weekEntries);
	const weeklyTracked = countTrackedHours(relevantWeekEntries);

	const weeklyExpected = countExpectedHoursUpToNow(
		weekStart,
		weekEnd,
		TARGETS.dailyTrackableHours,
		oooDates,
		startHour,
	);

	/* Also check if today is OOO */
	const todayIsOOO = oooDates.has(formatDateISO(currentDate));
	const weeklyPercent =
		weeklyExpected > 0 ? Math.round((weeklyTracked / weeklyExpected) * 100) : 0;

	/* Minimum target = 60% of elapsed hours */
	const dailyTarget = parseFloat(
		((dailyExpected * TARGETS.compliancePercent) / 100).toFixed(1),
	);
	const weeklyTarget = parseFloat(
		((weeklyExpected * TARGETS.compliancePercent) / 100).toFixed(1),
	);
	const dailyPace = parseFloat((dailyTracked - dailyTarget).toFixed(1));
	const weeklyPace = parseFloat((weeklyTracked - weeklyTarget).toFixed(1));

	return {
		dailyTracked,
		dailyBillable,
		dailyTiers,
		dailyExpected,
		dailyTarget,
		dailyPace,
		weeklyTracked,
		weeklyExpected,
		weeklyTarget,
		weeklyPercent,
		weeklyPace,
	};
}

/**
 * getOOODatesFromEntries
 * Scans a set of entries and returns a Set of date strings where
 * every tracked block is OOO (fully OOO days).
 *
 * @param {Array<Object>} entries - Array of time entry objects
 * @returns {Set<string>} Set of 'YYYY-MM-DD' date strings
 */
function getOOODatesFromEntries(entries) {
	const byDate = {};
	entries.forEach((e) => {
		if (!e.category) return;
		if (!byDate[e.date]) byDate[e.date] = [];
		byDate[e.date].push(e);
	});

	const oooDates = new Set();
	for (const [date, dayEntries] of Object.entries(byDate)) {
		if (
			dayEntries.length > 0 &&
			dayEntries.every((e) => e.category === "ooo")
		) {
			oooDates.add(date);
		}
	}
	return oooDates;
}

/**
 * renderSidebar
 * Generates the HTML for the stats sidebar.
 *
 * @param {Object} stats - Calculated stats from calculateSidebarStats
 * @returns {string} HTML string
 */
function renderSidebar(stats) {
	/* Daily progress bar — percentage of full day */
	const dailyBarPercent =
		TARGETS.dailyTrackableHours > 0
			? Math.min(
					100,
					Math.round((stats.dailyTracked / TARGETS.dailyTrackableHours) * 100),
				)
			: 0;
	/* Daily expected marker position — percentage of full day */
	const dailyMarkerPercent =
		TARGETS.dailyTrackableHours > 0
			? Math.min(
					100,
					Math.round((stats.dailyTarget / TARGETS.dailyTrackableHours) * 100),
				)
			: 0;

	/* Weekly progress bar — percentage of full week */
	const weeklyBarPercent =
		TARGETS.weeklyTrackableHours > 0
			? Math.min(
					100,
					Math.round(
						(stats.weeklyTracked / TARGETS.weeklyTrackableHours) * 100,
					),
				)
			: 0;
	/* Weekly expected marker position */
	const weeklyMarkerPercent =
		TARGETS.weeklyTrackableHours > 0
			? Math.min(
					100,
					Math.round((stats.weeklyTarget / TARGETS.weeklyTrackableHours) * 100),
				)
			: 0;

	/* Pace text and color class */
	function paceDisplay(pace, expected) {
		if (expected === 0) return { text: "Upcoming", cls: "pace-even" };
		const absPace = Math.abs(pace);
		if (pace >= 0.5)
			return { text: `${absPace} hrs ahead of pace`, cls: "pace-ahead" };
		if (pace > -0.5) return { text: "On pace", cls: "pace-even" };
		if (pace > -2)
			return { text: `${absPace} hrs behind pace`, cls: "pace-behind" };
		return { text: `${absPace} hrs behind pace`, cls: "pace-far-behind" };
	}

	const dailyPaceInfo = paceDisplay(stats.dailyPace, stats.dailyExpected);
	const weeklyPaceInfo = paceDisplay(stats.weeklyPace, stats.weeklyExpected);

	return `
    <!-- Action buttons -->
    <div class="sidebar-actions">
      <button id="btn-fill-lunch" class="sidebar-btn">Fill lunch</button>
      <button id="btn-today" class="sidebar-btn">Today</button>
      <button id="btn-notes" class="sidebar-btn sidebar-btn-notes">Notes (N)</button>
    </div>

    <!-- Daily tracked hours -->
    <div class="stat-card">
      <div class="stat-card-label">Tracked today</div>
      <div class="stat-card-value">
        ${stats.dailyTracked}
        <span class="text-sm font-normal text-stone-400">/ ${TARGETS.dailyTrackableHours} hrs</span>
      </div>
      <div class="progress-with-marker">
        <div class="progress-fill progress-fill-good" style="width: ${dailyBarPercent}%;"></div>
        ${
					dailyMarkerPercent > 0 && stats.dailyExpected > 0
						? `
          <div class="progress-marker" style="left: ${dailyMarkerPercent}%;"></div>
          <div class="progress-marker-label" style="left: ${dailyMarkerPercent}%;">${stats.dailyTarget}h min</div>
        `
						: ""
				}
      </div>
      <div class="pace-text ${dailyPaceInfo.cls}">${dailyPaceInfo.text}</div>
    </div>

    <!-- Weekly tracked hours -->
    <div class="stat-card">
      <div class="stat-card-label">Tracked this week</div>
      <div class="stat-card-value">
        ${stats.weeklyTracked}
        <span class="text-sm font-normal text-stone-400">/ ${TARGETS.weeklyTrackableHours} hrs</span>
      </div>
      <div class="progress-with-marker">
        <div class="progress-fill progress-fill-good" style="width: ${weeklyBarPercent}%;"></div>
        ${
					weeklyMarkerPercent > 0
						? `
          <div class="progress-marker" style="left: ${weeklyMarkerPercent}%;"></div>
          <div class="progress-marker-label" style="left: ${weeklyMarkerPercent}%;">${stats.weeklyTarget}h min</div>
        `
						: ""
				}
      </div>
      <div class="pace-text ${weeklyPaceInfo.cls}">${weeklyPaceInfo.text}</div>
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
  `;
}

/* ============================================================================
 * EDIT DROPDOWN
 * --------------------------------------------------------------------------
 * When a user clicks a time block, this dropdown appears allowing them
 * to select a category and fill in optional details.
 * ========================================================================= */

/**
 * attachAutocomplete
 * Attaches autocomplete behavior to a text input. Shows suggestions
 * from historical data after at least 1 character is typed.
 *
 * @param {HTMLInputElement} input - The input element
 * @param {string} field - The db field name ('subCategory', 'merchant', 'formerPOS')
 */
async function attachAutocomplete(input, field) {
	const allValues = await getUniqueFieldValues(field);
	if (allValues.length === 0) return;

	let activeIndex = -1;
	let listEl = null;

	/* Wrap the input's parent in relative positioning */
	input.parentElement.style.position = "relative";

	function showList(filter) {
		removeList();
		if (!filter || filter.length === 0) return;

		const matches = allValues.filter((v) =>
			v.toLowerCase().includes(filter.toLowerCase()),
		);
		if (matches.length === 0) return;

		/* Don't show if the input value exactly matches one result */
		if (
			matches.length === 1 &&
			matches[0].toLowerCase() === filter.toLowerCase()
		)
			return;

		activeIndex = -1;
		listEl = document.createElement("div");
		listEl.className = "autocomplete-list";

		matches.forEach((val, i) => {
			const item = document.createElement("div");
			item.className = "autocomplete-item";

			/* Highlight the matching portion */
			const lowerVal = val.toLowerCase();
			const lowerFilter = filter.toLowerCase();
			const matchStart = lowerVal.indexOf(lowerFilter);
			if (matchStart >= 0) {
				const before = val.substring(0, matchStart);
				const match = val.substring(matchStart, matchStart + filter.length);
				const after = val.substring(matchStart + filter.length);
				item.innerHTML = `${before}<span class="autocomplete-match">${match}</span>${after}`;
			} else {
				item.textContent = val;
			}

			item.addEventListener("mousedown", (e) => {
				/* mousedown instead of click so it fires before input blur */
				e.preventDefault();
				input.value = val;
				removeList();
				/* Trigger input event so any listeners are notified */
				input.dispatchEvent(new Event("input"));
			});

			listEl.appendChild(item);
		});

		input.parentElement.appendChild(listEl);
	}

	function removeList() {
		if (listEl) {
			listEl.remove();
			listEl = null;
		}
		activeIndex = -1;
	}

	/* Show suggestions as user types */
	input.addEventListener("input", () => {
		showList(input.value.trim());
	});

	/* Keyboard navigation */
	input.addEventListener("keydown", (e) => {
		if (!listEl) return;

		const items = listEl.querySelectorAll(".autocomplete-item");

		if (e.key === "ArrowDown") {
			e.preventDefault();
			activeIndex = Math.min(activeIndex + 1, items.length - 1);
			items.forEach((el, i) =>
				el.classList.toggle("active", i === activeIndex),
			);
			if (items[activeIndex])
				items[activeIndex].scrollIntoView({ block: "nearest" });
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
			items.forEach((el, i) =>
				el.classList.toggle("active", i === activeIndex),
			);
			if (items[activeIndex])
				items[activeIndex].scrollIntoView({ block: "nearest" });
		} else if (e.key === "Tab" || (e.key === "Enter" && activeIndex >= 0)) {
			/* Tab or Enter with a selected item fills it in */
			if (activeIndex >= 0 && items[activeIndex]) {
				e.preventDefault();
				e.stopPropagation();
				input.value = items[activeIndex].textContent;
				removeList();
				input.dispatchEvent(new Event("input"));
			}
		} else if (e.key === "Escape") {
			removeList();
		}
	});

	/* Hide on blur */
	input.addEventListener("blur", () => {
		/* Small delay to allow mousedown on items to fire first */
		setTimeout(removeList, 150);
	});

	/* Show on focus if there's already text */
	input.addEventListener("focus", () => {
		if (input.value.trim().length > 0) {
			showList(input.value.trim());
		}
	});
}

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

	/* Hide tooltips while dropdown is open */
	document.querySelectorAll(".time-block-filled").forEach((el) => {
		el.classList.add("tooltip-hidden");
	});

	const entry = entries[slot] || {};

	/* Create the dropdown element */
	const dropdown = document.createElement("div");
	dropdown.className = "edit-dropdown";
	dropdown.id = "active-dropdown";

	/* --- Category list --- */
	let html = `
    <div class="dropdown-body">

      <!-- LEFT: Category list -->
      <div class="dropdown-categories">
        ${CATEGORIES.filter((cat) => {
					const hidden = appState.settings.hiddenCategories || [];
					if (cat.id === "lunch" || cat.id === "ooo" || cat.id === "other")
						return true;
					if (entry.category === cat.id) return true;
					return !hidden.includes(cat.id);
				})
					.map((cat) => {
						const isSelected = entry.category === cat.id;
						return `
            <div class="dropdown-option ${isSelected ? "selected" : ""}"
                 data-category="${cat.id}">
              <div class="cat-dot" style="background: var(${cat.cssVar})"></div>
              <span>${cat.label}</span>
            </div>
          `;
					})
					.join("")}
      </div>

      <!-- RIGHT: Detail fields -->
      <div class="detail-panel" id="detail-fields">

        <!-- Sub-category (full width) -->
        <div class="field-group">
          <label class="field-label">Sub-category</label>
          <input type="text" id="edit-subcategory" autocomplete="off"
                 value="${entry.subCategory || ""}"
                 placeholder="e.g., product import, team standup..." />
        </div>

        <!-- Ticket (full width — URLs are long) -->
        <div class="field-group">
          <label class="field-label">Ticket</label>
          <input type="text" id="edit-ticket" autocomplete="off"
                 value="${entry.ticketLink || ""}"
                 placeholder="URL or ticket number..." />
        </div>

        <!-- Merchant + Former POS (side by side) -->
        ${
					appState.settings.enableMerchant || appState.settings.enableFormerPOS
						? `
        <div class="field-row">
          ${
						appState.settings.enableMerchant
							? `
          <div class="field-group">
            <label class="field-label">Merchant</label>
            <input type="text" id="edit-merchant" autocomplete="off"
                   value="${entry.merchant || ""}"
                   placeholder="Merchant name..." />
          </div>
          `
							: ""
					}
          ${
						appState.settings.enableFormerPOS
							? `
          <div class="field-group">
            <label class="field-label">Former POS</label>
            <input type="text" id="edit-formerpos" autocomplete="off"
                   value="${entry.formerPOS || ""}"
                   placeholder="Former POS..." />
          </div>
          `
							: ""
					}
        </div>
        `
						: ""
				}

        <!-- Notes (full width) -->
        <div class="field-group">
          <label class="field-label">Notes</label>
          <input type="text" id="edit-notes" autocomplete="off"
                 value="${entry.notes || ""}"
                 placeholder="Any additional context..." />
        </div>

        <!-- Billable + Urgent checkboxes -->
        <div class="flex gap-4 items-center" style="padding: 2px 0;">
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" id="edit-billable"
                   ${entry.billable ? "checked" : ""}
                   class="w-3.5 h-3.5 rounded border-stone-300 text-chronos-500 focus:ring-chronos-300" />
            <span class="text-xs" style="color: var(--text-secondary);">Billable</span>
          </label>
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" id="edit-urgent"
                   ${entry.urgent ? "checked" : ""}
                   class="w-3.5 h-3.5 rounded border-stone-300 text-red-500 focus:ring-red-300" />
            <span class="text-xs" style="color: var(--text-secondary);">Urgent</span>
          </label>
        </div>

        <!-- Warning (hidden, fills remaining space) -->
        <div id="edit-warning" style="display: none; flex: 1; align-items: flex-end; justify-content: flex-end; font-size: 11px; color: var(--danger);">
          Select a category
        </div>

      </div>
    </div>

    <!-- Full-width button row -->
    <div class="dropdown-buttons">
      <button id="edit-save"
              class="export-button text-white">
        Save
      </button>
      <button id="edit-copy"
              style="border: 0.5px solid var(--border-default); background: none; color: var(--text-secondary);">
        Copy
      </button>
      ${
				entry.category
					? `
      <button id="edit-clear"
              style="border: 0.5px solid var(--border-default); background: none; color: var(--text-secondary);">
        Clear
      </button>
      `
					: ""
			}
      <button id="edit-cancel"
              style="border: 0.5px solid var(--border-default); background: none; color: var(--text-secondary);">
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

	/* Attach autocomplete to searchable fields */
	const subCatInput = dropdown.querySelector("#edit-subcategory");
	if (subCatInput) attachAutocomplete(subCatInput, "subCategory");

	const merchantInput = dropdown.querySelector("#edit-merchant");
	if (merchantInput) {
		attachAutocomplete(merchantInput, "merchant");

		/* Auto-fill POS and ticket when merchant matches a known entry */
		let merchantFillTimeout;
		const autoFillFromMerchant = async () => {
			const merchantValue = merchantInput.value.trim();
			if (!merchantValue) return;

			const lastEntry = await getLastEntryForMerchant(merchantValue);
			if (!lastEntry) return;

			/* Only auto-fill if the field is empty — don't overwrite user input */
			const subCatInput = dropdown.querySelector("#edit-subcategory");
			if (subCatInput && !subCatInput.value.trim() && lastEntry.subCategory) {
				subCatInput.value = lastEntry.subCategory;
				subCatInput.style.color = "var(--accent-text-light)";
				subCatInput.addEventListener(
					"input",
					() => {
						subCatInput.style.color = "";
					},
					{ once: true },
				);
			}

			const posInput = dropdown.querySelector("#edit-formerpos");
			if (posInput && !posInput.value.trim() && lastEntry.formerPOS) {
				posInput.value = lastEntry.formerPOS;
				posInput.style.color = "var(--accent-text-light)";
				/* Reset color when user edits */
				posInput.addEventListener(
					"input",
					() => {
						posInput.style.color = "";
					},
					{ once: true },
				);
			}

			const ticketInput = dropdown.querySelector("#edit-ticket");
			if (ticketInput && !ticketInput.value.trim() && lastEntry.ticketLink) {
				ticketInput.value = lastEntry.ticketLink;
				ticketInput.style.color = "var(--accent-text-light)";
				ticketInput.addEventListener(
					"input",
					() => {
						ticketInput.style.color = "";
					},
					{ once: true },
				);
			}
		};

		merchantInput.addEventListener("input", () => {
			clearTimeout(merchantFillTimeout);
			merchantFillTimeout = setTimeout(autoFillFromMerchant, 500);
		});

		/* Also trigger on autocomplete selection (which fires an input event) */
		/* and on blur in case they tabbed away */
		merchantInput.addEventListener("blur", () => {
			clearTimeout(merchantFillTimeout);
			autoFillFromMerchant();
		});
	}

	const posInput = dropdown.querySelector("#edit-formerpos");
	if (posInput) attachAutocomplete(posInput, "formerPOS");

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
			console.log("Category selected:", selectedCategory);
			/* Hide warning if it was showing */
			const warning = dropdown.querySelector("#edit-warning");
			if (warning) warning.style.display = "none";
		});
	});

	/* Save button */
	dropdown.querySelector("#edit-save").addEventListener("click", async () => {
		/* Read selection from DOM in case the closure variable didn't update */
		const selectedOpt = dropdown.querySelector(".dropdown-option.selected");
		if (selectedOpt) selectedCategory = selectedOpt.dataset.category;

		if (!selectedCategory) {
			const warning = dropdown.querySelector("#edit-warning");
			if (warning) warning.style.display = "flex";
			return;
		}

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

	/* Re-enable tooltips */
	document.querySelectorAll(".tooltip-hidden").forEach((el) => {
		el.classList.remove("tooltip-hidden");
	});
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
		closeOOOPopover();
		navigateDay(-1);
	});
	document.getElementById("next-day")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		closeOOOPopover();
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
			closeOOOPopover();
			currentDate = parseDate(chip.dataset.date);
			renderTracker();
		});
	});

	/* Right-click on day chips to mark as OOO */
	document.querySelectorAll(".week-chip").forEach((chip) => {
		chip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			closeDropdown();
			closeWeekPopover();
			closeOOOPopover();
			showOOOPopover(chip.dataset.date, chip);
		});
	});

	/* Right-click on filled blocks to copy */
	document.querySelectorAll(".time-block-filled").forEach((block) => {
		block.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const slot = block.dataset.slot;
			if (entries[slot]) {
				copyBlock(slot);
			}
		});
	});

	/* --- Fill lunch button --- */
	document
		.getElementById("btn-fill-lunch")
		?.addEventListener("click", async () => {
			await fillLunch();
		});

	/* Notes panel */
	document.getElementById("btn-notes")?.addEventListener("click", () => {
		showNotesPanel();
	});

	/* View toggle */
	document.getElementById("toggle-day")?.addEventListener("click", () => {
		setActiveView("day");
		renderTracker();
	});
	document.getElementById("toggle-week")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		closeOOOPopover();
		setActiveView("week");
		renderWeekView();
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

	/* Tooltip positioning — flip below if near top of grid */
	document.querySelectorAll(".time-block-filled").forEach((block) => {
		block.addEventListener("mouseenter", () => {
			const tooltip = block.querySelector(".block-tooltip");
			if (!tooltip) return;

			const grid = document.querySelector(".tracker-grid");
			if (!grid) return;

			const blockRect = block.getBoundingClientRect();
			const gridRect = grid.getBoundingClientRect();

			/* If the block is within 120px of the top of the grid, flip tooltip below */
			if (blockRect.top - gridRect.top < 120) {
				tooltip.classList.add("tooltip-below");
			} else {
				tooltip.classList.remove("tooltip-below");
			}
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
		closeOOOPopover();
		setActiveView("day");
		renderTracker();
	});
	document.getElementById("toggle-week")?.addEventListener("click", () => {
		setActiveView("week");
		renderWeekView();
	});

	/* Week navigation */
	document.getElementById("prev-week")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		closeOOOPopover();
		const mon = weekDates[0];
		mon.setDate(mon.getDate() - 7);
		weekDates = getWeekDates(mon);
		currentDate = weekDates[0];
		renderWeekView();
	});
	document.getElementById("next-week")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		closeOOOPopover();
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
			closeOOOPopover();
			currentDate = parseDate(chip.dataset.date);
			setActiveView("day");
			renderTracker();
		});
	});

	document.querySelectorAll(".week-chip").forEach((chip) => {
		chip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			closeDropdown();
			closeWeekPopover();
			closeOOOPopover();
			showOOOPopover(chip.dataset.date, chip);
		});
	});

	/* Block clicks */
	document.querySelectorAll(".week-block").forEach((block) => {
		block.addEventListener("click", async (e) => {
			if (e.target.closest(".edit-dropdown")) return;

			if (activeDropdown) {
				closeDropdown();
				return;
			}

			const slot = block.dataset.slot;
			const date = block.dataset.date;

			if (block.classList.contains("time-block-empty")) {
				/* Empty block with clipboard: paste */
				if (clipboard) {
					await pasteBlock(date, slot);
					await renderWeekView();
					return;
				}
			}

			/* Both filled and empty blocks: open edit dropdown */
			showEditDropdown(slot, block, date, renderWeekView);
		});

		/* Double-click: jump to day view for that date */
		block.addEventListener("dblclick", () => {
			const date = block.dataset.date;
			currentDate = parseDate(date);
			setActiveView("day");
			renderTracker();
		});

		/* Right-click on filled blocks to copy in week view */
		document
			.querySelectorAll(".week-block.time-block-filled")
			.forEach((block) => {
				block.addEventListener("contextmenu", async (e) => {
					e.preventDefault();
					const slot = block.dataset.slot;
					const date = block.dataset.date;
					const dayEntries = await getEntriesForDate(date);
					const entry = dayEntries.find((ent) => ent.timeSlot === slot);
					if (entry) {
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
					}
				});
			});
	});
	/* Tooltip positioning — flip below if near top of grid */
	document
		.querySelectorAll(".week-block.time-block-filled")
		.forEach((block) => {
			block.addEventListener("mouseenter", () => {
				const tooltip = block.querySelector(".block-tooltip");
				if (!tooltip) return;

				const grid = document.querySelector(".tracker-grid");
				if (!grid) return;

				const blockRect = block.getBoundingClientRect();
				const gridRect = grid.getBoundingClientRect();

				if (blockRect.top - gridRect.top < 120) {
					tooltip.classList.add("tooltip-below");
				} else {
					tooltip.classList.remove("tooltip-below");
				}
			});
		});
	/* Fill lunch for all days in the week */
	document
		.getElementById("btn-fill-lunch")
		?.addEventListener("click", async () => {
			await fillLunchWeek();
		});

	/* Notes panel */
	document.getElementById("btn-notes")?.addEventListener("click", () => {
		showNotesPanel();
	});

	/* Today button — switch to day view on today's date */
	document.getElementById("btn-today")?.addEventListener("click", () => {
		closeDropdown();
		closeWeekPopover();
		closeOOOPopover();
		currentDate = new Date();
		weekDates = getWeekDates(currentDate);
		setActiveView("day");
		renderTracker();
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

	/* Fixed position at the top of the viewport */
	indicator.style.position = "fixed";
	indicator.style.top = "8px";
	indicator.style.left = "50%";
	indicator.style.transform = "translateX(-50%)";
	indicator.style.zIndex = "9999";
	indicator.style.width = "auto";
	indicator.style.maxWidth = "500px";
	document.body.appendChild(indicator);

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
	const existingGrid = document.querySelector(".tracker-grid");
	const savedScroll = existingGrid ? existingGrid.scrollTop : 0;

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
    <div class="tracker-nav">
    <div class="flex items-center justify-between mb-2">
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

      <div class="flex items-center gap-3">
        <!-- View toggle -->
        <div class="flex gap-1 bg-surface-100 rounded-lg p-0.5">
          <button id="toggle-day" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
            ${activeView === "day" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Day (D)</button>
          <button id="toggle-week" class="view-toggle text-xs px-3 py-1.5 rounded-md transition-colors
            ${activeView === "week" ? "bg-white text-stone-700 font-medium shadow-sm" : "text-stone-400 hover:text-stone-600"}">Week (W)</button>
        </div>
      </div>
    </div>
    </div>

    <!-- Clipboard indicator mounts here -->
    <div id="clipboard-mount"></div>

	<!-- Week day chips (matches day view) -->
	<div class="tracker-chips">
    <div class="flex gap-1" style="padding-left: 56px; padding-right: calc(224px + 24px);">
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
	</div>

    <!-- Week grid -->
    <div class="tracker-content">
      <div class="tracker-grid" id="time-grid">
        <div class="week-grid">

          <!-- Time rows -->
          ${timeSlots
						.map(
							(slot) => `
            <div class="week-grid-row">
              <!-- Time label -->
              <div class="w-14 flex-shrink-0 text-xs text-stone-400 pt-2.5 select-none">
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
                    <div class="flex-1 week-block time-block-filled cat-${entry.category} cursor-pointer relative group"
                        data-slot="${slot}" data-date="${dateStr}" style="position: relative;">
                      <span class="week-block-label">${cat?.label || ""}</span>
                      ${entry.merchant || entry.subCategory ? `<span class="week-block-sub">${[entry.merchant, entry.subCategory].filter(Boolean).join(" — ")}</span>` : ""}
                      <div class="absolute top-0.5 right-1 flex items-center gap-1">
                        ${entry.billable ? '<span class="text-[8px] text-emerald-500">$</span>' : ""}
                        ${entry.urgent ? '<span class="w-1 h-1 rounded-full bg-red-400 inline-block"></span>' : ""}
                      </div>
                      ${
												entry.category !== "lunch" && entry.category !== "ooo"
													? `
                      <div class="block-tooltip">
                        <div class="tooltip-header">
                          <div class="w-2 h-2 rounded-sm" style="background: var(${cat ? cat.cssVar : "--cat-other-border"})"></div>
                          ${cat?.label || entry.category}
                        </div>
                        ${entry.subCategory ? `<div class="tooltip-row"><span class="tooltip-label">Sub-category</span><span class="tooltip-value">${entry.subCategory}</span></div>` : ""}
                        ${entry.merchant ? `<div class="tooltip-row"><span class="tooltip-label">Merchant</span><span class="tooltip-value">${entry.merchant}</span></div>` : ""}
                        ${entry.formerPOS ? `<div class="tooltip-row"><span class="tooltip-label">Former POS</span><span class="tooltip-value">${entry.formerPOS}</span></div>` : ""}
                        ${entry.ticketLink ? `<div class="tooltip-row"><span class="tooltip-label">Ticket</span><span class="tooltip-value">#${entry.ticketLink.split("/").pop()}</span></div>` : ""}
                        ${entry.notes ? `<div class="tooltip-row"><span class="tooltip-label">Notes</span><span class="tooltip-value">${entry.notes}</span></div>` : ""}
                        <div class="tooltip-row"><span class="tooltip-label">Billable</span><span class="tooltip-value">${entry.billable ? "Yes" : "No"}</span></div>
                        ${entry.urgent ? `<div class="tooltip-row"><span class="tooltip-label">Urgent</span><span class="tooltip-value" style="color: var(--danger);">Yes</span></div>` : ""}
                      </div>
                      `
													: ""
											}
                    </div>
                  `;
									} else {
										return `
                    <div class="flex-1 week-block time-block-empty cursor-pointer"
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
        <div class="tracker-sidebar space-y-3">
        ${renderSidebar(sidebarStats)}
      </div>
    </div>
  `;

	/* Re-show clipboard indicator if active */
	if (clipboard) updateClipboardIndicator();

	/* Attach week view event listeners */
	attachWeekEventListeners();

	const newGrid = document.querySelector(".tracker-grid");
	if (newGrid) newGrid.scrollTop = savedScroll;
}

/* ============================================================================
 * NOTES VIEW
 * --------------------------------------------------------------------------
 * Weekly qualitative notes: wins, losses, issues to flag, and customer
 * meetings. Saved per ISO week and included in exports.
 * ========================================================================= */

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

/**
 * showOOOPopover
 * Shows a confirmation popover when right-clicking a day chip.
 * Asks if the user wants to mark the entire day as OOO.
 *
 * @param {string} dateStr - The date to mark as OOO
 * @param {Element} chipEl - The clicked chip element for positioning
 */
async function showOOOPopover(dateStr, chipEl) {
	const dayEntries = await getEntriesForDate(dateStr);
	const hasEntries = dayEntries.length > 0;
	const isAllOOO = hasEntries && dayEntries.every((e) => e.category === "ooo");
	const hasRealWork =
		hasEntries && dayEntries.some((e) => e.category && e.category !== "ooo");

	const popover = document.createElement("div");
	popover.className = "ooo-popover";
	popover.id = "ooo-popover";

	const dateDisplay = formatDateDisplay(parseDate(dateStr));

	if (isAllOOO) {
		/* State 2: Fully OOO — offer to clear, no confirmation needed */
		popover.innerHTML = `
      <div style="font-size: 13px; font-weight: 500; color: var(--text-primary); margin-bottom: 4px;">
        ${dateDisplay}
      </div>
      <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 10px;">
        This day is marked as OOO.
      </div>
      <div style="display: flex; gap: 6px;">
        <button id="ooo-clear" style="
          flex: 1; padding: 6px 0; text-align: center; font-size: 12px; font-weight: 500;
          border-radius: 6px; cursor: pointer; font-family: inherit; border: none;
          background: var(--danger); color: white;
        ">Clear day</button>
        <button id="ooo-cancel" style="
          flex: 1; padding: 6px 0; text-align: center; font-size: 12px; font-weight: 500;
          border-radius: 6px; cursor: pointer; font-family: inherit;
          border: 1px solid var(--border-default); background: none; color: var(--text-secondary);
        ">Cancel</button>
      </div>
    `;
	} else if (hasRealWork) {
		/* State 3: Has tracked work — offer to clear with confirmation step */
		popover.innerHTML = `
      <div style="font-size: 13px; font-weight: 500; color: var(--text-primary); margin-bottom: 4px;">
        ${dateDisplay}
      </div>
      <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 10px;">
        This day has ${dayEntries.length} tracked blocks.
      </div>
      <div id="ooo-actions" style="display: flex; gap: 6px;">
        <button id="ooo-clear" style="
          flex: 1; padding: 6px 0; text-align: center; font-size: 12px; font-weight: 500;
          border-radius: 6px; cursor: pointer; font-family: inherit; border: none;
          background: var(--danger); color: white;
        ">Clear day</button>
        <button id="ooo-cancel" style="
          flex: 1; padding: 6px 0; text-align: center; font-size: 12px; font-weight: 500;
          border-radius: 6px; cursor: pointer; font-family: inherit;
          border: 1px solid var(--border-default); background: none; color: var(--text-secondary);
        ">Cancel</button>
      </div>
      <div id="ooo-confirm-step" style="display: none;">
        <div style="font-size: 12px; color: var(--danger-text); background: var(--danger-bg); border-radius: 6px; padding: 8px; margin-bottom: 8px;">
          This will delete all ${dayEntries.length} tracked blocks. This cannot be undone.
        </div>
        <div style="display: flex; gap: 6px;">
          <button id="ooo-confirm-delete" style="
            flex: 1; padding: 6px 0; text-align: center; font-size: 12px; font-weight: 500;
            border-radius: 6px; cursor: pointer; font-family: inherit; border: none;
            background: var(--danger); color: white;
          ">Yes, clear day</button>
          <button id="ooo-confirm-back" style="
            flex: 1; padding: 6px 0; text-align: center; font-size: 12px; font-weight: 500;
            border-radius: 6px; cursor: pointer; font-family: inherit;
            border: 1px solid var(--border-default); background: none; color: var(--text-secondary);
          ">Go back</button>
        </div>
      </div>
    `;
	} else {
		/* State 1: Empty day — offer to mark as OOO */
		popover.innerHTML = `
      <div style="font-size: 13px; font-weight: 500; color: var(--text-primary); margin-bottom: 4px;">
        ${dateDisplay}
      </div>
      <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 10px;">
        Mark this entire day as out of office?
      </div>
      <div style="display: flex; gap: 6px;">
        <button id="ooo-confirm" style="
          flex: 1; padding: 6px 0; text-align: center; font-size: 12px; font-weight: 500;
          border-radius: 6px; cursor: pointer; font-family: inherit; border: none;
          background: var(--accent); color: white;
        ">Mark as OOO</button>
        <button id="ooo-cancel" style="
          flex: 1; padding: 6px 0; text-align: center; font-size: 12px; font-weight: 500;
          border-radius: 6px; cursor: pointer; font-family: inherit;
          border: 1px solid var(--border-default); background: none; color: var(--text-secondary);
        ">Cancel</button>
      </div>
    `;
	}

	/* Position near the chip */
	popover.style.visibility = "hidden";
	document.body.appendChild(popover);

	const chipRect = chipEl.getBoundingClientRect();
	const popoverRect = popover.getBoundingClientRect();
	const viewportWidth = window.innerWidth;

	let left = chipRect.left;
	let top = chipRect.bottom + 4;

	if (left + popoverRect.width + 16 > viewportWidth) {
		left = viewportWidth - popoverRect.width - 16;
	}
	if (left < 8) left = 8;

	popover.style.left = `${left}px`;
	popover.style.top = `${top}px`;
	popover.style.visibility = "visible";

	/* Mark as OOO (empty day) */
	popover.querySelector("#ooo-confirm")?.addEventListener("click", async () => {
		for (const slot of timeSlots) {
			await saveEntry({
				date: dateStr,
				timeSlot: slot,
				category: "ooo",
				subCategory: "",
				billable: false,
				urgent: false,
				ticketLink: "",
				merchant: "",
				formerPOS: "",
				notes: "",
			});
		}
		closeOOOPopover();
		await renderTracker();
	});

	/* Clear day — immediate for OOO, shows confirmation for real work */
	popover.querySelector("#ooo-clear")?.addEventListener("click", async () => {
		if (isAllOOO) {
			/* No confirmation needed for pure OOO days */
			const entries = await getEntriesForDate(dateStr);
			for (const entry of entries) {
				await deleteEntry(dateStr, entry.timeSlot);
			}
			closeOOOPopover();
			await renderTracker();
		} else {
			/* Show confirmation step */
			popover.querySelector("#ooo-actions").style.display = "none";
			popover.querySelector("#ooo-confirm-step").style.display = "block";
		}
	});

	/* Confirmation step: yes, delete everything */
	popover
		.querySelector("#ooo-confirm-delete")
		?.addEventListener("click", async () => {
			const entries = await getEntriesForDate(dateStr);
			for (const entry of entries) {
				await deleteEntry(dateStr, entry.timeSlot);
			}
			closeOOOPopover();
			await renderTracker();
		});

	/* Confirmation step: go back */
	popover.querySelector("#ooo-confirm-back")?.addEventListener("click", () => {
		popover.querySelector("#ooo-actions").style.display = "flex";
		popover.querySelector("#ooo-confirm-step").style.display = "none";
	});

	/* Cancel */
	popover.querySelector("#ooo-cancel")?.addEventListener("click", () => {
		closeOOOPopover();
	});
}

/**
 * closeOOOPopover
 * Removes any open OOO popover.
 */
function closeOOOPopover() {
	const existing = document.getElementById("ooo-popover");
	if (existing) existing.remove();
}

/**
 * showNotesPanel
 * Opens the slide-out notes panel. Behavior depends on context:
 *   - Contributor or manager viewing self: editable personal notes
 *   - Manager viewing specific team member: read-only member notes
 *   - Manager viewing all team: read-only notes grouped by section
 */
export async function showNotesPanel(externalState = null) {
	/* Use external state if tracker hasn't been initialized */
	if (externalState && !appState) {
		appState = externalState;
	}
	if (!appState) return;

	/* Initialize date/week data if tracker hasn't been opened yet */
	if (!currentDate) currentDate = new Date();
	if (!weekDates || weekDates.length === 0) {
		weekDates = getWeekDates(currentDate);
	}
	/* Close if already open */
	const existing = document.getElementById("notes-panel");
	if (existing) {
		closeNotesPanel();
		return;
	}

	const weekKey = getISOWeekKey(currentDate);

	/* Determine which mode we're in by checking the stats page state */
	const statsVisible = !document
		.getElementById("view-stats")
		?.classList.contains("hidden");
	const teamSelect = document.getElementById("team-member-select");
	const selectedMember = teamSelect ? teamSelect.value : "self";
	const isManager = appState.settings.role === "manager";

	let panelContent;
	let panelTitle;
	let panelSubtitle = `Week of ${formatDateDisplay(weekDates[0])}`;

	if (isManager && statsVisible && selectedMember === "all") {
		/* All team notes — grouped by section */
		panelTitle = "Team notes";
		panelContent = await renderAllTeamNotes(weekKey);
	} else if (isManager && statsVisible && selectedMember !== "self") {
		/* Specific team member notes — read only */
		panelTitle = `${selectedMember}'s notes`;
		panelContent = await renderTeamMemberNotes(selectedMember, weekKey);
	} else {
		/* Own notes — editable */
		panelTitle = "Weekly notes";
		panelContent = await renderOwnNotes(weekKey);
	}

	const panel = document.createElement("div");
	panel.className = "notes-panel";
	panel.id = "notes-panel";

	panel.innerHTML = `
    <div class="notes-panel-header">
      <div>
        <div style="font-size: 14px; font-weight: 500; color: var(--text-primary);">${panelTitle}</div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${panelSubtitle}</div>
      </div>
      <button id="notes-close" style="width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border-radius: 8px; border: 0.5px solid var(--border-default); background: none; color: var(--text-muted); cursor: pointer; font-size: 16px;">
        &times;
      </button>
    </div>

    ${panelContent}
  `;

	document.body.appendChild(panel);

	requestAnimationFrame(() => {
		panel.classList.add("open");
	});

	/* Close button */
	panel
		.querySelector("#notes-close")
		.addEventListener("click", closeNotesPanel);

	/* Close on Escape */
	const escHandler = (e) => {
		if (e.key === "Escape") {
			closeNotesPanel();
			document.removeEventListener("keydown", escHandler);
		}
	};
	document.addEventListener("keydown", escHandler);
}

/**
 * renderOwnNotes
 * Renders the editable personal notes form.
 */
async function renderOwnNotes(weekKey) {
	const existingNotes = await getWeeklyNotes(weekKey);
	const notes = existingNotes || {
		wins: "",
		losses: "",
		issues: "",
		customerMeetings: "",
	};

	const html = `
    <div class="notes-banner">
      These notes cover the entire week and will be included in your weekly export.
    </div>

    <div class="notes-save-status" id="notes-save-status"></div>

    <div class="notes-panel-body">
      <div style="margin-bottom: 16px;">
        <div class="notes-field-label">Wins of the week</div>
        <div class="notes-field-hint">Successful migrations, resolved tickets, shipped features.</div>
        <textarea id="notes-wins" rows="3" placeholder="e.g., Successfully migrated Merchant X to new POS...">${notes.wins || ""}</textarea>
      </div>

      <div style="margin-bottom: 16px;">
        <div class="notes-field-label">Losses of the week</div>
        <div class="notes-field-hint">Blockers, delays, things that took longer than expected.</div>
        <textarea id="notes-losses" rows="3" placeholder="e.g., CSV format issues delayed migration by 2 days...">${notes.losses || ""}</textarea>
      </div>

      <div style="margin-bottom: 16px;">
        <div class="notes-field-label">Issues to flag to management</div>
        <div class="notes-field-hint">Recurring problems, resource constraints, customer patterns.</div>
        <textarea id="notes-issues" rows="3" placeholder="e.g., Recurring import errors for merchants on RICOs...">${notes.issues || ""}</textarea>
      </div>

      <div style="margin-bottom: 16px;">
        <div class="notes-field-label">Customer meetings and engagements</div>
        <div class="notes-field-hint">External meetings, outcomes, and follow-ups needed.</div>
        <textarea id="notes-meetings" rows="3" placeholder="e.g., Met with qbedding2026 re: product import — follow-up Tuesday...">${notes.customerMeetings || ""}</textarea>
      </div>
    </div>
  `;

	/* Set up auto-save after the panel is in the DOM */
	setTimeout(() => {
		const panel = document.getElementById("notes-panel");
		if (!panel) return;

		let saveTimeout;
		const statusEl = panel.querySelector("#notes-save-status");

		const autoSave = async () => {
			const notesData = {
				wins: panel.querySelector("#notes-wins")?.value || "",
				losses: panel.querySelector("#notes-losses")?.value || "",
				issues: panel.querySelector("#notes-issues")?.value || "",
				customerMeetings: panel.querySelector("#notes-meetings")?.value || "",
			};
			await saveWeeklyNotes(weekKey, notesData);
			if (statusEl) {
				statusEl.textContent = "Saved";
				statusEl.style.color = "var(--positive)";
				setTimeout(() => {
					if (statusEl) statusEl.textContent = "";
				}, 2000);
			}
		};

		panel.querySelectorAll("textarea").forEach((ta) => {
			ta.addEventListener("input", () => {
				if (statusEl) {
					statusEl.textContent = "Saving...";
					statusEl.style.color = "var(--text-muted)";
				}
				clearTimeout(saveTimeout);
				saveTimeout = setTimeout(autoSave, 500);
			});
		});
	}, 100);

	return html;
}

/**
 * renderTeamMemberNotes
 * Renders a specific team member's notes (read-only).
 */
async function renderTeamMemberNotes(name, weekKey) {
	const notes = await getTeamMemberNotes(name, weekKey);

	if (!notes) {
		return `
      <div class="notes-panel-body">
        <div style="color: var(--text-muted); font-size: 13px; padding: 20px 0; text-align: center;">
          No notes submitted for this week.
        </div>
      </div>
    `;
	}

	const sections = [
		{ label: "Wins of the week", value: notes.wins },
		{ label: "Losses of the week", value: notes.losses },
		{ label: "Issues flagged to management", value: notes.issues },
		{
			label: "Customer meetings and engagements",
			value: notes.customerMeetings,
		},
	];

	return `
    <div class="notes-banner">
      Read-only — these are ${name}'s notes for this week.
    </div>
    <div class="notes-panel-body">
      ${sections
				.map((s) => {
					if (!s.value) return "";
					return `
          <div style="margin-bottom: 16px;">
            <div class="notes-field-label">${s.label}</div>
            <div style="font-size: 13px; color: var(--text-primary); line-height: 1.6; background: var(--bg-surface); border-radius: 8px; padding: 10px 12px; margin-top: 4px; white-space: pre-wrap;">${s.value}</div>
          </div>
        `;
				})
				.join("")}
      ${
				sections.every((s) => !s.value)
					? `
        <div style="color: var(--text-muted); font-size: 13px; text-align: center;">
          All sections are empty.
        </div>
      `
					: ""
			}
    </div>
  `;
}

/**
 * renderAllTeamNotes
 * Renders all team members' notes grouped by section.
 * Each entry is attributed to its author.
 */
async function renderAllTeamNotes(weekKey) {
	const allNotes = await getAllTeamNotesForWeek(weekKey);

	if (allNotes.length === 0) {
		return `
      <div class="notes-panel-body">
        <div style="color: var(--text-muted); font-size: 13px; padding: 20px 0; text-align: center;">
          No notes submitted for this week.
        </div>
      </div>
    `;
	}

	const sections = [
		{
			key: "wins",
			label: "Wins of the week",
			icon: "✓",
			color: "var(--positive)",
		},
		{
			key: "losses",
			label: "Losses of the week",
			icon: "—",
			color: "var(--danger)",
		},
		{
			key: "issues",
			label: "Issues flagged to management",
			icon: "!",
			color: "var(--warning)",
		},
		{
			key: "customerMeetings",
			label: "Customer meetings",
			icon: "●",
			color: "var(--info)",
		},
	];

	let html = `
    <div class="notes-banner">
      ${allNotes.length} team member${allNotes.length > 1 ? "s" : ""} submitted notes for this week.
    </div>
    <div class="notes-panel-body">
  `;

	sections.forEach((section) => {
		/* Collect all non-empty entries for this section */
		const entries = allNotes
			.filter((n) => n.notes[section.key] && n.notes[section.key].trim())
			.map((n) => ({ name: n.name, text: n.notes[section.key].trim() }));

		if (entries.length === 0) return;

		html += `
      <div style="margin-bottom: 20px;">
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 10px;">
          <span style="width: 18px; height: 18px; border-radius: 50%; background: ${section.color}; display: flex; align-items: center; justify-content: center; font-size: 10px; color: white; font-weight: 500; flex-shrink: 0;">${section.icon}</span>
          <span class="notes-field-label" style="margin: 0;">${section.label} (${entries.length})</span>
        </div>
    `;

		entries.forEach((entry) => {
			const initials = entry.name
				.split(" ")
				.map((n) => n[0])
				.join("")
				.toUpperCase()
				.slice(0, 2);

			html += `
        <div style="display: flex; gap: 10px; margin-bottom: 10px; padding-left: 4px;">
          <div style="width: 24px; height: 24px; border-radius: 50%; background: var(--accent-light); display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 500; color: var(--accent-text); flex-shrink: 0; margin-top: 2px;">${initials}</div>
          <div style="flex: 1;">
            <div style="font-size: 11px; font-weight: 500; color: var(--accent-text); margin-bottom: 2px;">${entry.name}</div>
            <div style="font-size: 13px; color: var(--text-primary); line-height: 1.6; background: var(--bg-surface); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap;">${entry.text}</div>
          </div>
        </div>
      `;
		});

		html += "</div>";
	});

	html += "</div>";
	return html;
}

/**
 * closeNotesPanel
 * Slides the notes panel closed and removes it.
 */
export function closeNotesPanel() {
	const panel = document.getElementById("notes-panel");
	if (!panel) return;

	panel.classList.remove("open");
	setTimeout(() => panel.remove(), 250);
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

/**
 * fillLunchWeek
 * Auto-fills lunch blocks for all 5 days of the current week.
 */
async function fillLunchWeek() {
	const lunchStart =
		appState.settings.lunchStartHour || TIME_DEFAULTS.lunchStartHour;
	const lunchBlocks =
		appState.settings.lunchBlocks || TIME_DEFAULTS.lunchBlocks;

	for (const day of weekDates) {
		const dateStr = formatDateISO(day);

		for (let i = 0; i < lunchBlocks; i++) {
			const hour = lunchStart + Math.floor((i * 30) / 60);
			const minute = (i * 30) % 60;
			const slot = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

			/* Only fill if the block is empty */
			const existing = await getEntriesForDate(dateStr);
			const blockExists = existing.find((e) => e.timeSlot === slot);
			if (!blockExists) {
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
		}
	}

	await renderWeekView();
}
