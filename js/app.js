/* ============================================================================
 * app.js — Chronos Main Application Controller
 * ============================================================================
 * Entry point for the app. Handles:
 *   - Initialization and first-launch onboarding
 *   - View routing (tracker / stats / manager / settings)
 *   - Navigation state management
 *   - Export button functionality
 *   - Global event coordination between modules
 * ========================================================================= */

import { VIEWS } from "./config.js";
import { getUserSettings, saveUserSettings, getTierMap } from "./db.js";
import { initTracker } from "./tracker.js";
import { initSettings } from "./settings.js";
import { initStats } from "./stats.js";
import {
	getISOWeekKey,
	getWeekDateRange,
	generateExportFilename,
	downloadJSON,
} from "./utils.js";
import { getEntriesForDateRange, getWeeklyNotes } from "./db.js";

/* ============================================================================
 * STATE
 * --------------------------------------------------------------------------
 * Minimal app-level state. Each view module manages its own internal state.
 * ========================================================================= */

const state = {
	currentView: VIEWS.TRACKER, // Which view is currently visible
	settings: null, // Cached user settings
	tierMap: null, // Cached tier mappings
};

/* ============================================================================
 * INITIALIZATION
 * --------------------------------------------------------------------------
 * Runs once when the page loads. Sets up the app, checks for first-launch
 * onboarding, and renders the initial view.
 * ========================================================================= */

async function init() {
	/* Load user settings and tier mappings from IndexedDB */
	state.settings = await getUserSettings();
	state.tierMap = await getTierMap();

	/* Check if this is a first-time user (no name set) */
	if (!state.settings.name) {
		showOnboarding();
	}

	/* Set up navigation button click handlers */
	setupNavigation();

	/* Set up the export button */
	setupExportButton();

	/* Show/hide manager nav button based on role */
	updateManagerVisibility();

	/* Initialize and render the default view (tracker) */
	await switchView(VIEWS.TRACKER);
}

/* ============================================================================
 * ONBOARDING
 * --------------------------------------------------------------------------
 * Shows the name input banner on first launch. Hides it once the user
 * saves their name.
 * ========================================================================= */

function showOnboarding() {
	const banner = document.getElementById("onboarding-banner");
	const input = document.getElementById("onboarding-name");
	const saveBtn = document.getElementById("onboarding-save");

	banner.classList.remove("hidden");

	/* Save name when button is clicked */
	saveBtn.addEventListener("click", async () => {
		const name = input.value.trim();
		if (!name) {
			input.focus();
			return;
		}

		/* Persist the name to settings */
		state.settings.name = name;
		await saveUserSettings(state.settings);

		/* Hide the banner with a smooth transition */
		banner.style.opacity = "0";
		banner.style.transform = "translateY(-8px)";
		banner.style.transition = "all 0.3s ease";
		setTimeout(() => banner.classList.add("hidden"), 300);
	});

	/* Also save on Enter key */
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") saveBtn.click();
	});
}

/* ============================================================================
 * NAVIGATION
 * --------------------------------------------------------------------------
 * Handles clicking the nav buttons (Tracker, My Stats, Team, Settings)
 * and switching between views.
 * ========================================================================= */

function setupNavigation() {
	/* Attach click handler to all nav buttons */
	document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
		btn.addEventListener("click", () => {
			const view = btn.dataset.view;
			switchView(view);
		});
	});
}

/**
 * switchView
 * Hides the current view and shows the requested one.
 * Also updates the active state on nav buttons.
 *
 * @param {string} viewId - One of the VIEWS constants
 */
async function switchView(viewId) {
	/* Hide all view containers */
	document.querySelectorAll(".view-container").forEach((el) => {
		el.classList.add("hidden");
	});

	/* Show the requested view */
	const viewEl = document.getElementById(`view-${viewId}`);
	if (viewEl) {
		viewEl.classList.remove("hidden");
		viewEl.classList.add("view-fade-in");
		/* Remove the animation class after it plays so it can re-trigger */
		setTimeout(() => viewEl.classList.remove("view-fade-in"), 200);
	}

	/* Update nav button active states */
	document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.view === viewId);
	});

	/* Update the view badge visibility */
	const badge = document.getElementById("view-badge");
	badge.classList.toggle("hidden", viewId !== VIEWS.MANAGER);

	if (viewId === VIEWS.TRACKER) {
		await initTracker(state);
	} else if (viewId === VIEWS.STATS) {
		await initStats(state);
	} else if (viewId === VIEWS.SETTINGS) {
		await initSettings(state, onSettingsChanged);
	}
	/* Manager view will be initialized in Phase 2 */

	state.currentView = viewId;
}

/**
 * updateManagerVisibility
 * Shows/hides the "Team" nav button based on whether the user
 * has the manager role.
 */
function updateManagerVisibility() {
	const managerBtn = document.getElementById("nav-manager");
	if (state.settings.role === "manager") {
		managerBtn.classList.remove("hidden");
	} else {
		managerBtn.classList.add("hidden");
	}
}

/**
 * onSettingsChanged
 * Callback fired by the settings module when the user updates their
 * settings. Refreshes cached state and updates the UI accordingly.
 *
 * @param {Object} newSettings - The updated settings object
 */
async function onSettingsChanged(newSettings) {
	state.settings = newSettings;
	state.tierMap = await getTierMap();
	updateManagerVisibility();

	/* If the tracker is currently visible, re-render it with new settings */
	if (state.currentView === VIEWS.TRACKER) {
		await initTracker(state);
	}
}

/* ============================================================================
 * EXPORT
 * --------------------------------------------------------------------------
 * Handles the "Export week" button. Generates a JSON file containing
 * all time entries and notes for the current week.
 * ========================================================================= */

function setupExportButton() {
	const btn = document.getElementById("btn-export");
	btn.addEventListener("click", exportCurrentWeek);
}

/**
 * exportCurrentWeek
 * Gathers all data for the current week and triggers a JSON download.
 */
async function exportCurrentWeek() {
	const today = new Date();
	const weekKey = getISOWeekKey(today);
	const { startDate, endDate } = getWeekDateRange(today);

	/* Gather time entries for the week */
	const entries = await getEntriesForDateRange(startDate, endDate);

	/* Gather qualitative notes for the week */
	const notes = await getWeeklyNotes(weekKey);

	/* Build the export object */
	const exportData = {
		exportDate: new Date().toISOString(),
		appVersion: "1.0.0",
		weekKey,
		startDate,
		endDate,
		contributor: {
			name: state.settings.name || "Unnamed",
			role: state.settings.role,
		},
		entries: entries.map((e) => ({
			/* Strip the internal auto-increment ID — not needed in exports */
			date: e.date,
			timeSlot: e.timeSlot,
			category: e.category,
			subCategory: e.subCategory || "",
			billable: e.billable || false,
			merchant: e.merchant || "",
			urgent: e.urgent || false,
			ticketLink: e.ticketLink || "",
			formerPOS: e.formerPOS || "",
			notes: e.notes || "",
		})),
		weeklyNotes: notes
			? {
					wins: notes.wins || "",
					losses: notes.losses || "",
					issues: notes.issues || "",
					customerMeetings: notes.customerMeetings || "",
				}
			: null,
		tierMap: state.tierMap,
	};

	/* Generate filename and trigger download */
	const filename = generateExportFilename(state.settings.name, weekKey);
	downloadJSON(exportData, filename);
}

/* ============================================================================
 * GLOBAL ACCESS
 * --------------------------------------------------------------------------
 * Expose the app state and key functions for use by other modules
 * that may need to read shared state.
 * ========================================================================= */

export function getAppState() {
	return state;
}

export function refreshView() {
	switchView(state.currentView);
}

/* ============================================================================
 * BOOT
 * --------------------------------------------------------------------------
 * Kick off initialization when the DOM is ready.
 * ========================================================================= */

document.addEventListener("DOMContentLoaded", init);
