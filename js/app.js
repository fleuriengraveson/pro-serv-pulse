/* ============================================================================
 * app.js — Time Tracker Main Application Controller
 * ============================================================================
 * Entry point for the app. Handles:
 *   - Initialization and first-launch onboarding
 *   - View routing (tracker / stats / manager / settings)
 *   - Navigation state management
 *   - Export button functionality
 *   - Global event coordination between modules
 * ========================================================================= */

import { VIEWS } from "./config.js";
import {
	getUserSettings,
	saveUserSettings,
	getTierMap,
	getEntriesForDateRange,
	getWeeklyNotes,
	migrateZendeskToAdmin,
} from "./db.js";
import { initTracker } from "./tracker.js";
import { initSettings } from "./settings.js";
import { initStats, getStatsContext } from "./stats.js";
import {
	getISOWeekKey,
	getWeekDateRange,
	getWeekDates,
	generateExportFilename,
	downloadJSON,
	parseDate,
	markWeekExported,
	getUnexportedWeeks,
} from "./utils.js";

/**
 * getTrackerWeekDates
 * Reads the currently displayed week from the tracker module.
 * Returns null if the tracker hasn't rendered yet.
 */
function getTrackerWeekDates() {
	/* The tracker stores weekDates in its module scope, but we can
     infer it from the displayed date label in the nav */
	const dateLabel = document.getElementById("current-date");
	if (!dateLabel) return null;

	/* Parse "Week of Monday, Apr 27" or similar */
	const text = dateLabel.textContent.trim();
	const match = text.match(/Week of (.+)/);
	if (!match) return null;

	/* Try to parse the date from the label */
	const parsed = new Date(match[1] + ", " + new Date().getFullYear());
	if (isNaN(parsed.getTime())) return null;

	return getWeekDates(parsed);
}

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
	updateExportReportVisibility();

	/* One-time migration: convert zendesk_admin entries to admin */
	await migrateZendeskToAdmin();

	/* Check if this is a first-time user (no name set) */
	if (!state.settings.name) {
		showOnboarding();
	}

	/* Set up navigation button click handlers */
	setupNavigation();

	/* Set up the export button */
	setupExportButton();

	/* Initialize and render the default view (tracker) */
	const savedView = localStorage.getItem("chronos-app-view") || VIEWS.TRACKER;
	await switchView(savedView);
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
	localStorage.setItem("chronos-app-view", viewId);

	/* Check if export reminders are needed */
	await updateExportReminder();
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
	updateExportReportVisibility();

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
	const menuBtn = document.getElementById("btn-export-menu");
	const dropdown = document.getElementById("export-dropdown");
	const exportAllBtn = document.getElementById("btn-export-all");

	btn.addEventListener("click", exportCurrentWeek);

	/* Toggle dropdown on arrow click */
	menuBtn?.addEventListener("click", (e) => {
		e.stopPropagation();
		dropdown?.classList.toggle("hidden");
	});

	/* Export all weeks */
	exportAllBtn?.addEventListener("click", async () => {
		dropdown?.classList.add("hidden");
		await exportAllWeeks();
	});

	/* Export team report (manager only) */
	const reportBtn = document.getElementById("btn-export-report");
	reportBtn?.addEventListener("click", async () => {
		dropdown?.classList.add("hidden");
		await exportTeamReport();
	});

	/* Close dropdown on outside click */
	document.addEventListener("click", () => {
		dropdown?.classList.add("hidden");
	});
}

/**
 * updateExportReportVisibility
 * Shows or hides the team report export option based on role.
 */
function updateExportReportVisibility() {
	const reportBtn = document.getElementById("btn-export-report");
	if (reportBtn) {
		reportBtn.classList.toggle("hidden", state.settings.role !== "manager");
	}
}

/**
 * updateExportReminder
 * Shows or hides the export reminder banner based on unexported weeks.
 */
async function updateExportReminder() {
	/* Remove existing banner */
	const existing = document.getElementById("export-reminder");
	if (existing) existing.remove();

	const { getFirstTrackedDate } = await import("./db.js");
	const firstDate = await getFirstTrackedDate();
	const unexported = getUnexportedWeeks(firstDate);

	if (unexported.length === 0) return;

	const banner = document.createElement("div");
	banner.id = "export-reminder";
	banner.style.cssText = `
    position: sticky;
    top: 0;
    z-index: 100;
    background: linear-gradient(135deg, rgba(192,132,252,0.1), rgba(103,232,249,0.1));
    border: 0.5px solid var(--accent-border);
    border-radius: 10px;
    padding: 10px 16px;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  `;

	const weekLabels =
		unexported.length === 1
			? unexported[0]
			: `${unexported.length} weeks (${unexported[0]} — ${unexported[unexported.length - 1]})`;

	banner.innerHTML = `
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="width: 24px; height: 24px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 12px; color: white; font-weight: 500; flex-shrink: 0;">!</div>
      <div>
        <div style="font-size: 13px; font-weight: 500; color: var(--text-primary);">Don't forget to export your time</div>
        <div style="font-size: 11px; color: var(--text-muted);">
          ${
						unexported.length === 1
							? `${unexported[0]} hasn't been exported yet. Fill out your notes and export before the weekend.`
							: `${weekLabels} haven't been exported. Please export your missing weeks.`
					}
        </div>
      </div>
    </div>
    <div style="display: flex; gap: 6px; flex-shrink: 0;">
      <button id="reminder-export" style="
        font-size: 12px; font-weight: 500; padding: 5px 14px; border-radius: 8px;
        background: var(--accent); color: white; border: none; cursor: pointer; font-family: inherit;
      ">${unexported.length === 1 ? "Export week" : "Export all"}</button>
      <button id="reminder-dismiss" style="
        font-size: 12px; padding: 5px 10px; border-radius: 8px;
        background: none; color: var(--text-muted); border: 0.5px solid var(--border-default); cursor: pointer; font-family: inherit;
      ">Later</button>
    </div>
  `;

	/* Insert at the top of the app container, after the header */
	const header = document.getElementById("app-header");
	header.parentNode.insertBefore(banner, header.nextSibling);

	/* Export button — exports the missing week(s) */
	banner
		.querySelector("#reminder-export")
		.addEventListener("click", async () => {
			if (unexported.length === 1) {
				/* Single week — export just that one */
				const weekKey = unexported[0];
				const refDate = parseDate(
					weekKey.replace(/W/, "") + "-1",
				); /* Approximate — we'll use getWeekDates */

				/* Parse week key to get a date in that week */
				const [yearStr, weekStr] = weekKey.split("-W");
				const year = parseInt(yearStr);
				const week = parseInt(weekStr);
				const jan4 = new Date(year, 0, 4);
				const dayOfYear = (week - 1) * 7 + 1 - jan4.getDay() + 1;
				const weekDate = new Date(year, 0, dayOfYear);

				const { startDate, endDate } = getWeekDateRange(weekDate);
				const entries = await getEntriesForDateRange(startDate, endDate);
				const notes = await getWeeklyNotes(weekKey);

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

				const filename = generateExportFilename(state.settings.name, weekKey);
				downloadJSON(exportData, filename);
				markWeekExported(weekKey);
			} else {
				/* Multiple weeks — use export all */
				await exportAllWeeks();
				unexported.forEach((wk) => markWeekExported(wk));
			}
			updateExportReminder();
		});

	/* Dismiss — hide for this session only */
	banner.querySelector("#reminder-dismiss").addEventListener("click", () => {
		banner.remove();
	});
}

/**
 * exportCurrentWeek
 * Exports whichever week is currently displayed in the tracker.
 * Falls back to the current week if tracker hasn't been initialized.
 */
async function exportCurrentWeek() {
	/* Try to get the displayed week from the tracker's nav label */
	const trackerWeekDates = getTrackerWeekDates();
	const refDate = trackerWeekDates ? trackerWeekDates[0] : new Date();

	const weekKey = getISOWeekKey(refDate);
	const { startDate, endDate } = getWeekDateRange(refDate);

	const entries = await getEntriesForDateRange(startDate, endDate);
	const notes = await getWeeklyNotes(weekKey);

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

	const filename = generateExportFilename(state.settings.name, weekKey);
	downloadJSON(exportData, filename);

	/* Mark this week as exported and update the reminder banner */
	markWeekExported(weekKey);
	updateExportReminder();
}

/**
 * exportAllWeeks
 * Exports all tracked weeks as a single JSON file.
 * The manager import handler accepts this multi-week format.
 */
async function exportAllWeeks() {
	const { getFirstTrackedDate } = await import("./db.js");
	const firstDate = await getFirstTrackedDate();

	if (!firstDate) {
		alert("No tracked data to export.");
		return;
	}

	/* Build week-by-week exports from first tracked date to now */
	const weeks = [];
	const now = new Date();
	const d = parseDate(firstDate);

	/* Rewind to Monday of the first week */
	const dayOfWeek = d.getDay();
	const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
	d.setDate(d.getDate() + mondayOffset);

	while (d <= now) {
		const weekKey = getISOWeekKey(d);
		const { startDate, endDate } = getWeekDateRange(d);
		const entries = await getEntriesForDateRange(startDate, endDate);

		if (entries.length > 0) {
			const notes = await getWeeklyNotes(weekKey);

			weeks.push({
				weekKey,
				startDate,
				endDate,
				entries: entries.map((e) => ({
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
			});
		}

		d.setDate(d.getDate() + 7);
	}

	const exportData = {
		exportDate: new Date().toISOString(),
		appVersion: "1.0.0",
		format: "multi-week",
		contributor: {
			name: state.settings.name || "Unnamed",
			role: state.settings.role,
		},
		weeks,
		tierMap: state.tierMap,
	};

	const safeName = (state.settings.name || "unnamed")
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/[^a-z0-9_]/g, "");
	const filename = `${safeName}_all_weeks.json`;
	downloadJSON(exportData, filename);

	/* Mark all exported weeks */
	weeks.forEach((w) => markWeekExported(w.weekKey));
	updateExportReminder();
}

/**
 * exportTeamReport
 * Generates a beautifully styled HTML report in a new tab for printing to PDF.
 * Uses the currently selected period and team member from the stats view.
 */
async function exportTeamReport() {
	/* Get the current stats context (period, member, data) */
	const ctx = await getStatsContext();
	if (!ctx) {
		alert("Please open the Stats page first to select a period and view.");
		return;
	}

	const {
		range,
		entries,
		tracked,
		billable,
		expectedHours,
		byCategory,
		byTier,
		byMerchant,
		byPOS,
		urgentHours,
		urgentPct,
		selectedMember,
		teamMembers,
		flaggedMerchants,
		flaggedPOS,
	} = ctx;

	const tierMap = state.tierMap || {};
	const isAllTeam = selectedMember === "all";
	const tierTotal = (byTier[1] || 0) + (byTier[2] || 0) + (byTier[3] || 0);
	const t1Pct =
		tierTotal > 0 ? Math.round(((byTier[1] || 0) / tierTotal) * 100) : 0;
	const t2Pct =
		tierTotal > 0 ? Math.round(((byTier[2] || 0) / tierTotal) * 100) : 0;
	const t3Pct = tierTotal > 0 ? 100 - t1Pct - t2Pct : 0;
	const billablePct = tracked > 0 ? Math.round((billable / tracked) * 100) : 0;

	/* Sort categories by hours */
	const sortedCats = Object.entries(byCategory)
		.filter(([id]) => id !== "lunch" && id !== "ooo")
		.sort((a, b) => b[1] - a[1]);
	const catTotal = sortedCats.reduce((s, [, h]) => s + h, 0);

	/* Build member compliance data for all-team view */
	let complianceRows = "";
	if (isAllTeam) {
		const byMember = {};
		entries.forEach((e) => {
			const name = e.memberName || "Unknown";
			if (!byMember[name]) byMember[name] = [];
			byMember[name].push(e);
		});

		const members = Object.entries(byMember)
			.map(([name, memberEntries]) => {
				const mTracked =
					memberEntries.filter((e) => e.category && e.category !== "ooo")
						.length * 0.5;
				const mBillable =
					memberEntries.filter((e) => e.billable && e.category !== "ooo")
						.length * 0.5;
				const mByTier = {};
				[1, 2, 3].forEach((t) => {
					mByTier[t] = 0;
				});
				memberEntries.forEach((e) => {
					if (!e.category) return;
					const tier = tierMap[e.category];
					if (tier && mByTier[tier] !== undefined) mByTier[tier] += 0.5;
				});
				const mTierTotal = mByTier[1] + mByTier[2] + mByTier[3];
				const mT1Pct =
					mTierTotal > 0 ? Math.round((mByTier[1] / mTierTotal) * 100) : 0;
				const dates = [...new Set(memberEntries.map((e) => e.date))];
				const trackedDays = dates.filter((d) =>
					memberEntries.some(
						(e) => e.date === d && e.category && e.category !== "ooo",
					),
				);
				const lunchDays = trackedDays.filter((d) =>
					memberEntries.some((e) => e.date === d && e.category === "lunch"),
				);
				const compPct =
					expectedHours > 0 ? Math.round((mTracked / expectedHours) * 100) : 0;

				return {
					name,
					tracked: mTracked,
					billable: mBillable,
					t1Pct: mT1Pct,
					compPct,
					lunchDays: lunchDays.length,
					trackedDays: trackedDays.length,
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));

		complianceRows = members
			.map(
				(m) => `
      <tr>
        <td style="padding: 6px 10px; font-weight: 500;">${m.name}</td>
        <td style="padding: 6px 10px; text-align: right;">${m.tracked} hrs</td>
        <td style="padding: 6px 10px; text-align: right; color: ${m.compPct >= 60 ? "#10B981" : m.compPct >= 42 ? "#F59E0B" : "#EF4444"}; font-weight: 500;">${m.compPct}%</td>
        <td style="padding: 6px 10px; text-align: right;">${m.billable} hrs</td>
        <td style="padding: 6px 10px; text-align: right;">${m.t1Pct}%</td>
        <td style="padding: 6px 10px; text-align: center; color: ${m.lunchDays / m.trackedDays >= 0.8 ? "#10B981" : m.lunchDays / m.trackedDays >= 0.5 ? "#F59E0B" : "#EF4444"};">${m.lunchDays}/${m.trackedDays}</td>
      </tr>
    `,
			)
			.join("");
	}

	/* Build merchant rows */
	const sortedMerchants = Object.entries(byMerchant)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10);
	const merchantTotal = sortedMerchants.reduce((s, [, h]) => s + h, 0);

	/* Build POS rows */
	const sortedPOS = Object.entries(byPOS)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8);
	const posTotal = sortedPOS.reduce((s, [, h]) => s + h, 0);

	/* Category color map */
	const catColors = {};
	const { CATEGORIES } = await import("./config.js");
	CATEGORIES.forEach((c) => {
		catColors[c.id] = c.hex;
	});

	const reportTitle = isAllTeam
		? `Team Report — ${range.label}`
		: `${selectedMember} — ${range.label}`;

	const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${reportTitle} | Time-Tracking</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    @page {
      size: A4;
      margin: 20mm 18mm;
    }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
      .page-break { page-break-before: always; }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      color: #1C1917;
      font-size: 11px;
      line-height: 1.5;
      background: white;
    }
    .container { max-width: 800px; margin: 0 auto; padding: 20px; }
    .header {
      display: flex; justify-content: space-between; align-items: flex-start;
      border-bottom: 2px solid #8B5CF6; padding-bottom: 16px; margin-bottom: 24px;
    }
    .header-title { font-size: 20px; font-weight: 600; color: #1C1917; }
    .header-sub { font-size: 12px; color: #78716C; margin-top: 4px; }
    .header-logo { font-size: 14px; font-weight: 600; color: #8B5CF6; }
    .header-date { font-size: 10px; color: #A8A29E; }
    .section { margin-bottom: 24px; }
    .section-title {
      font-size: 13px; font-weight: 600; color: #1C1917;
      margin-bottom: 10px; padding-bottom: 4px;
      border-bottom: 0.5px solid #E7E5E4;
    }
    .metrics-grid {
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 10px; margin-bottom: 24px;
    }
    .metric-card {
      background: #F9FAFB; border-radius: 8px; padding: 12px;
      border: 0.5px solid #E7E5E4;
    }
    .metric-label { font-size: 10px; color: #78716C; margin-bottom: 4px; }
    .metric-value { font-size: 18px; font-weight: 600; }
    .metric-sub { font-size: 10px; color: #A8A29E; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th {
      text-align: left; padding: 6px 10px; font-weight: 500;
      color: #78716C; font-size: 10px; border-bottom: 1px solid #E7E5E4;
    }
    td { padding: 6px 10px; border-bottom: 0.5px solid #F5F5F4; }
    .tier-bar {
      display: flex; height: 8px; border-radius: 4px; overflow: hidden;
    }
    .cat-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
    .cat-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
    .cat-bar-track { flex: 1; height: 6px; background: #F5F5F4; border-radius: 3px; overflow: hidden; }
    .cat-bar-fill { height: 100%; border-radius: 3px; }
    .cat-name { width: 140px; flex-shrink: 0; font-size: 11px; }
    .cat-hrs { width: 50px; text-align: right; font-weight: 500; font-size: 11px; }
    .cat-pct { width: 35px; text-align: right; color: #A8A29E; font-size: 10px; }
    .alert-card {
      display: flex; gap: 8px; padding: 8px 10px; border-radius: 6px;
      margin-bottom: 6px; align-items: flex-start;
    }
    .alert-flag { background: #FEF2F2; }
    .alert-warning { background: #FFFBEB; }
    .alert-info { background: #EFF6FF; }
    .alert-icon {
      width: 16px; height: 16px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 9px; color: white; font-weight: 600; flex-shrink: 0;
    }
    .alert-text { font-size: 11px; line-height: 1.5; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .print-btn {
      position: fixed; bottom: 20px; right: 20px;
      padding: 10px 24px; font-size: 14px; font-weight: 500;
      background: #8B5CF6; color: white; border: none; border-radius: 10px;
      cursor: pointer; font-family: inherit;
      box-shadow: 0 4px 12px rgba(139,92,246,0.3);
    }
    .footer {
      margin-top: 32px; padding-top: 12px; border-top: 0.5px solid #E7E5E4;
      display: flex; justify-content: space-between;
      font-size: 10px; color: #A8A29E;
    }
  </style>
</head>
<body>
  <div class="container">

    <!-- Header -->
    <div class="header">
      <div>
        <div class="header-title">${reportTitle}</div>
        <div class="header-sub">${range.startDate} to ${range.endDate}${isAllTeam ? ` — ${Object.keys(ctx.byMember || {}).length || teamMembers.length} team members` : ""}</div>
      </div>
      <div style="text-align: right;">
        <div class="header-logo">Time-Tracking</div>
        <div class="header-date">Generated ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</div>
      </div>
    </div>

    <!-- Top metrics -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Tracked hours</div>
        <div class="metric-value">${tracked}</div>
        <div class="metric-sub">of ${expectedHours} expected</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Time allocation</div>
        <div class="tier-bar" style="margin: 8px 0;">
          ${t1Pct > 0 ? `<div style="width: ${t1Pct}%; background: #8B5CF6;"></div>` : ""}
          ${t2Pct > 0 ? `<div style="width: ${t2Pct}%; background: #10B981;"></div>` : ""}
          ${t3Pct > 0 ? `<div style="width: ${t3Pct}%; background: #A8A29E;"></div>` : ""}
        </div>
        <div class="metric-sub">T1: ${t1Pct}% | T2: ${t2Pct}% | T3: ${t3Pct}%</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Billable ratio</div>
        <div class="metric-value">${billablePct}%</div>
        <div class="metric-sub">${billable} of ${tracked} hrs</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Urgent work</div>
        <div class="metric-value">${urgentPct}%</div>
        <div class="metric-sub">${urgentHours} hrs flagged urgent</div>
      </div>
    </div>

    ${
			isAllTeam
				? `
    <!-- Team compliance table -->
    <div class="section">
      <div class="section-title">Team compliance</div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th style="text-align: right;">Tracked</th>
            <th style="text-align: right;">Compliance</th>
            <th style="text-align: right;">Billable</th>
            <th style="text-align: right;">Tier 1</th>
            <th style="text-align: center;">Lunch</th>
          </tr>
        </thead>
        <tbody>
          ${complianceRows}
        </tbody>
      </table>
    </div>
    `
				: ""
		}

    <!-- Hours by area -->
    <div class="section">
      <div class="section-title">Hours by area</div>
      ${sortedCats
				.map(([id, hours]) => {
					const pct = catTotal > 0 ? Math.round((hours / catTotal) * 100) : 0;
					const maxHrs = sortedCats[0][1];
					const barPct = Math.round((hours / maxHrs) * 100);
					const color = catColors[id] || "#A8A8A8";
					const cat = CATEGORIES.find((c) => c.id === id);
					return `
        <div class="cat-row">
          <div class="cat-dot" style="background: ${color};"></div>
          <div class="cat-name">${cat?.label || id}</div>
          <div class="cat-bar-track">
            <div class="cat-bar-fill" style="width: ${barPct}%; background: ${color}; opacity: 0.7;"></div>
          </div>
          <div class="cat-hrs">${hours} hrs</div>
          <div class="cat-pct">${pct}%</div>
        </div>`;
				})
				.join("")}
    </div>

    ${
			sortedMerchants.length > 0 || sortedPOS.length > 0
				? `
    <!-- Merchant / POS breakdown -->
    <div class="section two-col">
      ${
				sortedMerchants.length > 0
					? `
      <div>
        <div class="section-title">Merchant time</div>
        ${sortedMerchants
					.map(([name, hours]) => {
						const pct =
							merchantTotal > 0 ? Math.round((hours / merchantTotal) * 100) : 0;
						const barPct = Math.round((hours / sortedMerchants[0][1]) * 100);
						return `
          <div class="cat-row">
            <div class="cat-name" style="width: 120px;">${name}</div>
            <div class="cat-bar-track">
              <div class="cat-bar-fill" style="width: ${barPct}%; background: #8B5CF6; opacity: 0.5;"></div>
            </div>
            <div class="cat-hrs">${hours} hrs</div>
            <div class="cat-pct">${pct}%</div>
          </div>`;
					})
					.join("")}
      </div>
      `
					: "<div></div>"
			}
      ${
				sortedPOS.length > 0
					? `
      <div>
        <div class="section-title">Time by POS</div>
        ${sortedPOS
					.map(([name, hours]) => {
						const pct = posTotal > 0 ? Math.round((hours / posTotal) * 100) : 0;
						const barPct = Math.round((hours / sortedPOS[0][1]) * 100);
						return `
          <div class="cat-row">
            <div class="cat-name" style="width: 120px;">${name}</div>
            <div class="cat-bar-track">
              <div class="cat-bar-fill" style="width: ${barPct}%; background: #06B6D4; opacity: 0.5;"></div>
            </div>
            <div class="cat-hrs">${hours} hrs</div>
            <div class="cat-pct">${pct}%</div>
          </div>`;
					})
					.join("")}
      </div>
      `
					: "<div></div>"
			}
    </div>
    `
				: ""
		}

    ${
			flaggedMerchants.length > 0 || flaggedPOS.length > 0
				? `
    <!-- Concentration alerts -->
    <div class="section">
      <div class="section-title">Concentration flags</div>
      ${flaggedMerchants
				.map(
					(m) => `
        <div class="alert-card alert-warning">
          <div class="alert-icon" style="background: #F59E0B;">!</div>
          <div class="alert-text"><strong>${m.name}</strong> — ${m.reason}</div>
        </div>
      `,
				)
				.join("")}
      ${flaggedPOS
				.map(
					(p) => `
        <div class="alert-card alert-warning">
          <div class="alert-icon" style="background: #F59E0B;">!</div>
          <div class="alert-text"><strong>${p.name}</strong> — ${p.reason}</div>
        </div>
      `,
				)
				.join("")}
    </div>
    `
				: ""
		}

    <!-- Footer -->
    <div class="footer">
      <span>Time Tracker — ${isAllTeam ? "Team" : "Individual"} Report</span>
      <span>${range.label} | Generated by ${state.settings.name || "Manager"}</span>
    </div>

  </div>

  <!-- Print button (hidden in print) -->
  <button class="print-btn no-print" onclick="window.print()">
    Save as PDF
  </button>
</body>
</html>`;

	/* Open in a new tab */
	const reportWindow = window.open("", "_blank");
	reportWindow.document.write(html);
	reportWindow.document.close();
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
