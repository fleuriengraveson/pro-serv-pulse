/* ============================================================================
 * stats.js — Individual Contributor Stats Dashboard
 * ============================================================================
 * Renders the personal analytics dashboard with:
 *   - Time period filters (daily, weekly, monthly, quarterly, FY, CY)
 *   - Top metrics cards (total hours, tracked %, Tier 1, untracked)
 *   - Auto-generated insights with outlier detection
 *   - Hours by area donut chart (Chart.js)
 *   - Tier breakdown horizontal stacked bar
 *   - Daily breakdown bars for the current week
 *   - Merchant time table (if enabled)
 *   - Weekly trend line chart
 *
 * This module is initialized by app.js when the stats view is active.
 * ========================================================================= */

import { CATEGORIES, TARGETS, TIERS, TIME_DEFAULTS } from "./config.js";
import {
	getEntriesForDateRange,
	getTierMap,
	getFirstTrackedDate,
	getTeamMemberList,
	getTeamMemberData,
	getAllTeamEntriesForPeriod,
	getTeamMemberNotes,
	getAllTeamTicketStats,
	getTeamMemberTicketStats,
	getAllTeamDayMeta,
} from "./db.js";
import {
	formatDateISO,
	formatDateDisplay,
	formatDateShort,
	parseDate,
	getWeekDates,
	getWeekDateRange,
	getISOWeekKey,
	getFiscalYear,
	getFiscalYearRange,
	aggregateByCategory,
	aggregateByTier,
	aggregateByMerchant,
	aggregateByPOS,
	countTrackedHours,
	countBillableHours,
	countTotalHours,
	countOOOHours,
	countOOODays,
	countExpectedHoursUpToNow,
	filterEntriesUpToNow,
	detectOutlier,
	getCategoryLabel,
	getCategoryHex,
	countUrgentHours,
	detectDisproportionate,
	calculateMean,
	calculateStdDev,
} from "./utils.js";
import { getChartColors, isDark } from "./theme.js";
import { showNotesPanel } from "./tracker.js";

/* ============================================================================
 * MODULE STATE
 * ========================================================================= */

let appState = null; // Reference to global app state
let currentPeriod = "weekly"; // Active time filter
let periodDate = new Date(); // The reference date for period navigation
let chartInstances = {}; // Track Chart.js instances for cleanup

/* --- Manager team-data auto-refresh state ---------------------------------
 * The stats page imported team JSON only once (on load), so a manager who
 * opened it in the morning never saw entries that arrived later in the day.
 * These hold the auto-refresh machinery so it can start when the manager
 * enters the stats view and be torn down again when they leave.
 */

let teamRefreshTimer = null; // setInterval id for the periodic re-import (null = not running)
let onVisibilityChange = null; // visibilitychange handler ref, kept so we can detach it
let isRefreshing = false; // guard so two refreshes can't overlap if an import runs long
let lastImportedAt = null; // Date of the most recent successful import (used by the freshness label, next pass)

const TEAM_REFRESH_MS = 60000; // how often to re-check the sync folder while stats is open (60s)
let selectedMember = "all"; // 'all', a member name, or 'self'
let teamMembers = []; // Cached list of imported team members

/* Period filter options */
const PERIODS = [
	{ id: "weekly", label: "Weekly (W)" },
	{ id: "monthly", label: "Monthly (M)" },
	{ id: "quarterly", label: "Quarterly (Q)" },
	{ id: "fy", label: "FY (F)" },
	{ id: "cy", label: "Calendar year (Y)" },
];

/* ============================================================================
 * INITIALIZATION
 * ========================================================================= */

/**
 * initStats
 * Called by app.js when the stats view becomes active.
 *
 * @param {Object} state - The global app state (settings, tierMap)
 */
export async function initStats(state) {
	appState = state;

	/* Load team members if manager */
	if (appState.settings.role === "manager") {
		/* Auto-import from sync folder if connected */
		try {
			const { autoImportTeamData, getSyncStatus } = await import("./sync.js");
			const importStatus = await getSyncStatus("import");
			if (importStatus.connected && importStatus.hasPermission) {
				const result = await autoImportTeamData();
				lastImportedAt = new Date(); // record freshness so the header label shows on first render
				if (result.imported > 0 || result.updated > 0) {
					console.log(
						`Auto-imported: ${result.imported} new, ${result.updated} updated`,
					);
				}
			}
		} catch (e) {
			console.warn("Auto-import not available:", e.message);
		}

		teamMembers = await getTeamMemberList();
		/* Default to 'all' for managers, 'self' for contributors */
		if (
			selectedMember !== "self" &&
			!teamMembers.find((m) => m.name === selectedMember)
		) {
			selectedMember = "all";
		}
	} else {
		selectedMember = "self";
		teamMembers = [];
	}

	await renderStats();

	/* Begin auto-refreshing team data while the manager stays on this view.
	 * (No-op for contributors.) Torn down by cleanupStats() on view switch. */
	startTeamAutoRefresh();
}

/* ============================================================================
 * TEAM DATA AUTO-REFRESH (manager only)
 * --------------------------------------------------------------------------
 * autoImportTeamData() already re-reads the sync folder fresh on every call,
 * so the only thing missing was calling it again after the first load. These
 * helpers re-import on a timer and whenever the tab regains visibility, and
 * only re-render when the import actually changed something (so an idle
 * dashboard doesn't redraw and lose the manager's scroll position).
 * ========================================================================= */

/**
 * refreshTeamData
 * Re-imports team JSON from the connected sync folder and, if anything changed,
 * refreshes the member list and re-renders the dashboard. Safe to call
 * repeatedly; no-ops for non-managers or when no import folder is connected.
 */
async function refreshTeamData(forceRender = false) {
	/* Only managers import team data, and skip if a previous run is still going */
	if (appState.settings.role !== "manager" || isRefreshing) return;

	isRefreshing = true;
	try {
		const { autoImportTeamData, getSyncStatus } = await import("./sync.js");

		/* Bail quietly if the import folder isn't connected / authorized */
		const importStatus = await getSyncStatus("import");
		if (!importStatus.connected || !importStatus.hasPermission) return;

		const result = await autoImportTeamData();
		lastImportedAt = new Date();

		/* Redraw when data changed, OR when a manual refresh forces it so the
		 * "Updated HH:MM" label always reflects the click even on no-change days. */
		if (forceRender || result.imported > 0 || result.updated > 0) {
			teamMembers = await getTeamMemberList();
			await renderStats();
		}
	} catch (e) {
		console.warn("Team data refresh failed:", e.message);
	} finally {
		isRefreshing = false;
	}
}

/**
 * startTeamAutoRefresh
 * Begins periodic re-import and wires a visibilitychange listener so the
 * dashboard also refreshes the moment the manager returns to the tab.
 * Clears any existing timer first so we never stack two intervals.
 */
function startTeamAutoRefresh() {
	stopTeamAutoRefresh(); /* defensive: never run two timers at once */
	if (appState.settings.role !== "manager") return;

	/* Periodic re-import — handles the "opened at 9am and left it on screen" case */
	teamRefreshTimer = setInterval(refreshTeamData, TEAM_REFRESH_MS);

	/* Immediate refresh when the tab becomes visible again — handles the
	 * "alt-tabbed away and came back" case without waiting for the interval. */
	onVisibilityChange = () => {
		if (document.visibilityState === "visible") refreshTeamData();
	};
	document.addEventListener("visibilitychange", onVisibilityChange);
}

/**
 * stopTeamAutoRefresh
 * Tears down the interval and the visibilitychange listener.
 */
function stopTeamAutoRefresh() {
	if (teamRefreshTimer !== null) {
		clearInterval(teamRefreshTimer);
		teamRefreshTimer = null;
	}
	if (onVisibilityChange) {
		document.removeEventListener("visibilitychange", onVisibilityChange);
		onVisibilityChange = null;
	}
}

/**
 * cleanupStats
 * Called by app.js (switchView) when navigating away from the stats view, so
 * the auto-refresh timer/listener don't keep running on other views.
 */
export function cleanupStats() {
	stopTeamAutoRefresh();
}

/* ============================================================================
 * DATE RANGE CALCULATIONS
 * --------------------------------------------------------------------------
 * Each period type resolves to a { startDate, endDate, label } object
 * that drives data queries and display.
 * ========================================================================= */

/**
 * getPeriodRange
 * Returns the date range and display label for the current period/date.
 *
 * @returns {Object} { startDate, endDate, label }
 */
function getPeriodRange() {
	const d = periodDate;

	switch (currentPeriod) {
		case "daily": {
			const dateStr = formatDateISO(d);
			return {
				startDate: dateStr,
				endDate: dateStr,
				label: formatDateDisplay(d),
			};
		}

		case "weekly": {
			const weekDates = getWeekDates(d);
			return {
				startDate: formatDateISO(weekDates[0]),
				endDate: formatDateISO(weekDates[4]),
				label: `Week of ${formatDateDisplay(weekDates[0])}`,
			};
		}

		case "monthly": {
			const year = d.getFullYear();
			const month = d.getMonth();
			const startDate = formatDateISO(new Date(year, month, 1));
			const endDate = formatDateISO(new Date(year, month + 1, 0));
			const label = d.toLocaleDateString("en-US", {
				month: "long",
				year: "numeric",
			});
			return { startDate, endDate, label };
		}

		case "quarterly": {
			const fy = getFiscalYear(d);
			const month = d.getMonth(); // 0-indexed
			let fq, startMonth, startYear;

			if (month >= 3 && month <= 5) {
				fq = 1;
				startMonth = 3;
				startYear = fy - 1;
			} else if (month >= 6 && month <= 8) {
				fq = 2;
				startMonth = 6;
				startYear = fy - 1;
			} else if (month >= 9 && month <= 11) {
				fq = 3;
				startMonth = 9;
				startYear = fy - 1;
			} else {
				fq = 4;
				startMonth = 0;
				startYear = fy;
			}

			const startDate = formatDateISO(new Date(startYear, startMonth, 1));
			const endDate = formatDateISO(new Date(startYear, startMonth + 3, 0));
			const label = `Q${fq} FY${fy}`;
			return { startDate, endDate, label };
		}

		case "fy": {
			const fy = getFiscalYear(d);
			const range = getFiscalYearRange(fy);
			return { ...range, label: `FY ${fy}` };
		}

		case "cy": {
			const year = d.getFullYear();
			return {
				startDate: `${year}-01-01`,
				endDate: `${year}-12-31`,
				label: `${year}`,
			};
		}

		default:
			return getPeriodRange.call({ ...this, currentPeriod: "weekly" });
	}
}

/**
 * navigatePeriod
 * Moves the period date forward or backward by one period unit.
 *
 * @param {number} direction - +1 for next, -1 for previous
 */
function navigatePeriod(direction) {
	const d = new Date(periodDate);

	switch (currentPeriod) {
		case "daily":
			d.setDate(d.getDate() + direction);
			/* Skip weekends */
			if (d.getDay() === 0) d.setDate(d.getDate() + (direction > 0 ? 1 : -2));
			if (d.getDay() === 6) d.setDate(d.getDate() + (direction > 0 ? 2 : -1));
			break;
		case "weekly":
			d.setDate(d.getDate() + direction * 7);
			break;
		case "monthly":
			d.setMonth(d.getMonth() + direction);
			break;
		case "quarterly":
			d.setMonth(d.getMonth() + direction * 3);
			break;
		case "fy":
			d.setFullYear(d.getFullYear() + direction);
			break;
		case "cy":
			d.setFullYear(d.getFullYear() + direction);
			break;
	}

	periodDate = d;
}

/**
 * getHistoricalWeeklyData
 * Fetches the past N weeks of data for trend analysis and outlier detection.
 * Sources data from the appropriate place based on the selected member.
 *
 * @param {number} numWeeks - Maximum number of historical weeks to fetch
 * @returns {Promise<Array<Object>>} Array of { weekKey, entries, tracked, byCategory, byTier }
 */
async function getHistoricalWeeklyData(numWeeks = 8) {
	const weeks = [];
	const tierMap = await getTierMap();
	const d = new Date(periodDate);

	/* Find first tracked date from the appropriate source */
	let firstDate;
	if (selectedMember === "self") {
		firstDate = await getFirstTrackedDate();
	} else if (selectedMember === "all") {
		/* For all team, find the earliest date across all team data */
		const allTeamData = await getAllTeamEntriesForPeriod(
			"2000-01-01",
			"2099-12-31",
		);
		firstDate =
			allTeamData.length > 0
				? allTeamData
						.map((e) => e.date)
						.filter(Boolean)
						.sort()[0]
				: null;
	} else {
		/* Specific team member */
		const memberData = await getTeamMemberData(
			selectedMember,
			"2000-01-01",
			"2099-12-31",
		);
		firstDate =
			memberData.length > 0
				? memberData
						.map((e) => e.date)
						.filter(Boolean)
						.sort()[0]
				: null;
	}

	/* Start from last week, skip the current incomplete week */
	for (let i = 1; i <= numWeeks; i++) {
		const refDate = new Date(d);
		refDate.setDate(refDate.getDate() - i * 7);

		const weekDates = getWeekDates(refDate);
		const startDate = formatDateISO(weekDates[0]);
		const endDate = formatDateISO(weekDates[4]);

		/* Stop if this week is entirely before the first tracked date */
		if (firstDate && endDate < firstDate) break;

		/* Fetch entries from the appropriate source */
		let entries;
		if (selectedMember === "self") {
			entries = await getEntriesForDateRange(startDate, endDate);
		} else if (selectedMember === "all") {
			entries = await getAllTeamEntriesForPeriod(startDate, endDate);
		} else {
			entries = await getTeamMemberData(selectedMember, startDate, endDate);
		}

		/* Skip weeks with zero entries — they're gaps, not real data */
		if (entries.length === 0) continue;

		const oooDates = getOOODatesFromEntries(entries);
		const oooCount = oooDates.size;

		weeks.push({
			weekKey: getISOWeekKey(refDate),
			startDate,
			entries,
			tracked: countTrackedHours(entries),
			billable: countBillableHours(entries),
			byCategory: aggregateByCategory(entries),
			byTier: aggregateByTier(entries, tierMap),
			oooCount,
			expectedHours: (5 - oooCount) * TARGETS.dailyTrackableHours,
		});
	}

	return weeks;
}

/* ============================================================================
 * INSIGHT GENERATION
 * --------------------------------------------------------------------------
 * Compares current period data against historical averages to surface
 * actionable insights (outliers, trends, compliance status).
 * ========================================================================= */

/**
 * generateInsights
 * Creates an array of insight objects for display in the insights panel.
 *
 * @param {Object} currentStats - Aggregated stats for the current period
 * @param {Array} history       - Historical weekly data from getHistoricalWeeklyData
 * @returns {Array<Object>} Array of { type, icon, message } objects
 */
function generateInsights(currentStats, history) {
	const insights = [];

	/* Need at least 3 weeks of history WITH data for meaningful comparisons */
	const weeksWithData = history.filter((w) => w.tracked > 0);
	if (weeksWithData.length < 3) {
		insights.push({
			type: "info",
			icon: "i",
			message:
				"Keep tracking — insights will appear once you have 3+ weeks of data.",
		});
		return insights;
	}

	/* Skip the current week in history for comparisons */
	/* All weeks in history are now completed past weeks */
	const pastWeeks = history.filter((w) => w.tracked > 0);
	const tierMap = appState.tierMap || {};

	/* --- Compliance check --- */
	/* Calculate expected hours accounting for OOO */
	const oooDates = getOOODatesFromEntries(currentStats.entries || []);
	const adjustedExpected = (5 - oooDates.size) * TARGETS.dailyTrackableHours;
	const trackedPercent =
		adjustedExpected > 0 ? (currentStats.tracked / adjustedExpected) * 100 : 0;

	if (trackedPercent >= TARGETS.compliancePercent) {
		insights.push({
			type: "positive",
			icon: "✓",
			message: `<strong>Strong tracking compliance</strong> — ${Math.round(trackedPercent)}% tracked, well above the ${TARGETS.compliancePercent}% target.`,
		});
	} else {
		insights.push({
			type: "warning",
			icon: "!",
			message: `<strong>Below tracking target</strong> — ${Math.round(trackedPercent)}% tracked vs. the ${TARGETS.compliancePercent}% target. You need ${Math.max(0, (TARGETS.compliancePercent / 100) * adjustedExpected - currentStats.tracked).toFixed(1)} more hours.`,
		});
	}

	/* --- Category outlier detection --- */
	for (const cat of CATEGORIES) {
		if (cat.id === "lunch" || cat.id === "other") continue;

		const currentHours = currentStats.byCategory[cat.id] || 0;
		if (currentHours === 0) continue;

		const historicalHours = pastWeeks.map((w) => w.byCategory[cat.id] || 0);
		const outlier = detectOutlier(currentHours, historicalHours);

		if (outlier) {
			const direction = outlier.direction === "high" ? "up" : "down";
			const changeText = `${Math.abs(outlier.percentChange)}%`;
			const avgText = `${outlier.mean} hrs`;

			if (outlier.direction === "high") {
				insights.push({
					type: "warning",
					icon: "!",
					message: `<strong>${cat.label} ${direction} ${changeText}</strong> — you spent ${currentHours} hrs this period vs. your average of ${avgText}.`,
				});
			} else {
				insights.push({
					type: "info",
					icon: "i",
					message: `<strong>${cat.label} ${direction} ${changeText}</strong> — ${currentHours} hrs this period vs. your average of ${avgText}.`,
				});
			}
		}
	}

	/* --- Tier 1 trend --- */
	const currentTier1 = currentStats.byTier[1] || 0;
	const historicalTier1 = pastWeeks.map((w) => w.byTier[1] || 0);
	const tier1Outlier = detectOutlier(currentTier1, historicalTier1);

	if (tier1Outlier && tier1Outlier.direction === "high") {
		insights.push({
			type: "positive",
			icon: "✓",
			message: `<strong>Tier 1 time increasing</strong> — ${currentTier1} hrs of customer-facing work, up from your average of ${tier1Outlier.mean} hrs.`,
		});
	} else if (tier1Outlier && tier1Outlier.direction === "low") {
		insights.push({
			type: "info",
			icon: "i",
			message: `<strong>Tier 1 time decreasing</strong> — ${currentTier1} hrs of customer-facing work, down from your average of ${tier1Outlier.mean} hrs.`,
		});
	}

	/* --- Billable check --- */
	if (currentStats.billable > 0) {
		const billablePercent =
			currentStats.tracked > 0
				? Math.round((currentStats.billable / currentStats.tracked) * 100)
				: 0;
		insights.push({
			type: "info",
			icon: "i",
			message: `<strong>${billablePercent}% of tracked time is billable</strong> — ${currentStats.billable} hrs flagged as billable scope work.`,
		});
	}

	return insights;
}

/**
 * getOOODatesFromEntries
 * Scans entries and returns a Set of date strings where every
 * tracked block is OOO (fully OOO days).
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

/* ============================================================================
 * MAIN RENDER
 * ========================================================================= */

async function renderStats() {
	if (currentPeriod === "daily") currentPeriod = "weekly";
	const container = document.getElementById("view-stats");
	const tierMap = await getTierMap();
	const range = getPeriodRange();

	let allEntries;
	let entries;

	if (appState.settings.role === "manager" && selectedMember === "all") {
		/* All team data — aggregate across all imported members */
		allEntries = await getAllTeamEntriesForPeriod(
			range.startDate,
			range.endDate,
		);
		entries = filterEntriesUpToNow(allEntries);
		console.log("Team data:", {
			selectedMember,
			range,
			allEntriesCount: allEntries.length,
			filteredCount: entries.length,
			hasMemberNames: entries.length > 0 ? entries[0].memberName : "no entries",
		});
	} else if (
		appState.settings.role === "manager" &&
		selectedMember !== "self"
	) {
		/* Specific team member's data */
		allEntries = await getTeamMemberData(
			selectedMember,
			range.startDate,
			range.endDate,
		);
		entries = filterEntriesUpToNow(allEntries);
	} else {
		/* Own data (contributor or manager viewing self) */
		allEntries = await getEntriesForDateRange(range.startDate, range.endDate);
		entries = filterEntriesUpToNow(allEntries);
	}

	/* Load ticket stats for the period */
	let ticketStats = [];
	if (appState.settings.role === "manager") {
		if (selectedMember === "all") {
			ticketStats = await getAllTeamTicketStats(range.startDate, range.endDate);
		} else if (selectedMember !== "self") {
			ticketStats = await getTeamMemberTicketStats(
				selectedMember,
				range.startDate,
				range.endDate,
			);
		}
	}

	/* Load queue day data for the period (all-team view only)
	 * Builds a lookup of memberName → count of days marked on queue */
	let queueDaysByMember = {};
	if (appState.settings.role === "manager" && selectedMember === "all") {
		const dayMetaRecords = await getAllTeamDayMeta(
			range.startDate,
			range.endDate,
		);
		dayMetaRecords.forEach((m) => {
			if (m.onQueue) {
				queueDaysByMember[m.memberName] =
					(queueDaysByMember[m.memberName] || 0) + 1;
			}
		});
	}

	/* Aggregate stats */
	const tracked = countTrackedHours(entries);

	const total = countTotalHours(entries);
	const billable = countBillableHours(entries);
	const byCategory = aggregateByCategory(entries);
	const byTier = aggregateByTier(entries, tierMap);
	const byMerchant = aggregateByMerchant(entries);
	const byPOS = aggregateByPOS(entries);
	const urgentHours = countUrgentHours(entries);
	const urgentPct = tracked > 0 ? Math.round((urgentHours / tracked) * 100) : 0;
	const flaggedMerchants =
		Object.keys(byMerchant).length > 0 &&
		(selectedMember !== "self" || appState.settings.enableMerchant)
			? detectDisproportionate(byMerchant)
			: [];
	const flaggedPOS =
		Object.keys(byPOS).length > 0 &&
		(selectedMember !== "self" || appState.settings.enableFormerPOS)
			? detectDisproportionate(byPOS)
			: [];
	let expectedHours = await getExpectedHours(allEntries, allEntries);

	/* For "All team" view, calculate expected hours per member and sum them */
	if (appState.settings.role === "manager" && selectedMember === "all") {
		const memberNames = [
			...new Set(allEntries.map((e) => e.memberName).filter(Boolean)),
		];
		if (memberNames.length > 0) {
			let totalExpected = 0;
			for (const name of memberNames) {
				const memberEntries = allEntries.filter((e) => e.memberName === name);
				const memberExpected = await getExpectedHours(
					memberEntries,
					memberEntries,
				);
				totalExpected += memberExpected;
			}
			expectedHours = totalExpected;
		}
	}

	const currentStats = {
		tracked,
		total,
		billable,
		byCategory,
		byTier,
		byMerchant,
		byPOS,
		entries,
	};

	/* Fetch historical data for insights and trend chart */
	const history = await getHistoricalWeeklyData(8);

	/* Determine compliance status */
	const trackedPercent =
		expectedHours > 0 ? Math.round((tracked / expectedHours) * 100) : 0;
	let progressClass = "progress-fill-good";
	if (trackedPercent < TARGETS.compliancePercent) {
		progressClass =
			trackedPercent < TARGETS.compliancePercent * 0.7
				? "progress-fill-bad"
				: "progress-fill-warn";
	}

	/* Destroy old chart instances */
	Object.values(chartInstances).forEach((c) => c.destroy());
	chartInstances = {};

	/* Build the HTML */
	container.innerHTML = `

    <!-- ================================================================
      PERIOD FILTERS
      ================================================================ -->
    <div class="flex items-center justify-between mb-6 pb-4 border-b border-stone-100">
      <!-- Left: Period chips + team selector for managers -->
      <div class="flex items-center gap-4">
        <!-- Period filter chips -->
        <div class="flex gap-1">
          ${PERIODS.map(
						(p) => `
            <button class="period-chip text-xs px-3 py-1.5 rounded-lg transition-colors
              ${
								p.id === currentPeriod
									? "bg-chronos-100 text-chronos-600 border border-chronos-200 font-medium"
									: "text-stone-400 border border-stone-100 hover:text-stone-600 hover:border-stone-200"
							}"
              data-period="${p.id}">
              ${p.label}
            </button>
          `,
					).join("")}
        </div>

        ${
					appState.settings.role === "manager" && teamMembers.length > 0
						? `
        <!-- Team member selector -->
        <div style="border-left: 0.5px solid var(--border-default); padding-left: 12px;">
          <select id="team-member-select"
                  style="font-size: 12px; padding: 5px 10px; border-radius: 8px; border: 0.5px solid var(--border-default); background: var(--bg-input); color: var(--text-primary); font-family: inherit; min-width: 160px;">
            <option value="all" ${selectedMember === "all" ? "selected" : ""}>All team (${teamMembers.length})</option>
            <optgroup label="Team members">
              ${teamMembers
								.map(
									(m) => `
                <option value="${m.name}" ${selectedMember === m.name ? "selected" : ""}>${m.name}</option>
              `,
								)
								.join("")}
            </optgroup>
            <optgroup label="—">
              <option value="self" ${selectedMember === "self" ? "selected" : ""}>My stats</option>
            </optgroup>
          </select>
        </div>
        `
						: ""
				}
      </div>

	  <!-- Notes + Period navigation -->
      <div class="flex items-center gap-3">
	  ${
			appState.settings.role === "manager"
				? `
        <!-- Team-data freshness + manual refresh (managers only).
             #stats-last-imported is painted from lastImportedAt on every render;
             #stats-refresh-btn forces an immediate re-import (wired in attachStatsListeners). -->
        <div class="flex items-center gap-2">
          <span id="stats-last-imported" style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">
            ${
							lastImportedAt
								? "Updated " +
									lastImportedAt.toLocaleTimeString([], {
										hour: "2-digit",
										minute: "2-digit",
									})
								: ""
						}
          </span>
          <button id="stats-refresh-btn" class="sidebar-btn" style="padding: 5px 12px; font-size: 12px;" title="Re-import team data from the sync folder now">
            Refresh
          </button>
        </div>
        `
				: ""
		}
        ${
					currentPeriod === "weekly"
						? `
        <button id="stats-notes-btn" class="sidebar-btn sidebar-btn-notes" style="padding: 5px 12px; font-size: 12px;">
          Notes (N)
        </button>
        `
						: ""
				}
         <!-- Period navigation -->
      <div class="flex items-center gap-2">
        <button id="period-prev" class="w-7 h-7 flex items-center justify-center rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
        </button>
        <span class="text-sm font-medium min-w-[180px] text-center">${range.label}</span>
        <button id="period-next" class="w-7 h-7 flex items-center justify-center rounded-lg border border-stone-200 text-stone-400 hover:text-stone-600 transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>
      </div>
	  </div>
    </div>

    <!-- ================================================================
		TOP METRICS ROW
    ================================================================ -->
    <div class="grid ${(() => {
			const hasTickets =
				ticketStats.length > 0 &&
				selectedMember !== "all" &&
				selectedMember !== "self";
			if (hasTickets) return "grid-cols-5";
			return "grid-cols-4";
		})()} gap-3 mb-6">

      <!-- Card 1: Tracked hours with pace -->
      <div class="stat-card">
        <div class="stat-card-label">Tracked hours <span class="info-bubble" data-help="Total tracked hours excluding OOO. Future blocks are not included. 60% is the minimum target.">i</span></div>
			<div class="stat-card-value">${tracked}<span class="text-sm font-normal text-stone-400"> / ${expectedHours} hrs</span></div>
			<div class="progress-with-marker">
				<div class="progress-fill progress-fill-good"
					style="width: ${expectedHours > 0 ? Math.min(100, Math.round((tracked / expectedHours) * 100)) : 0}%"></div>
				${
					expectedHours > 0
						? `
					<div class="progress-marker" style="left: ${TARGETS.compliancePercent}%;"></div>
					<div class="progress-marker-label" style="left: ${TARGETS.compliancePercent}%;">${((expectedHours * TARGETS.compliancePercent) / 100).toFixed(1)}h min</div>
				`
						: ""
				}
				</div>
				${(() => {
					const minTarget = (expectedHours * TARGETS.compliancePercent) / 100;
					const isTimeAware =
						currentPeriod === "daily" || currentPeriod === "weekly";

					if (isTimeAware) {
						if (tracked >= expectedHours) {
							return `<div class="pace-text pace-ahead">Complete — ${(tracked - expectedHours).toFixed(1)} hrs over</div>`;
						} else if (tracked >= minTarget) {
							return `<div class="pace-text pace-ahead">On track — ${(expectedHours - tracked).toFixed(1)} hrs remaining</div>`;
						} else if (minTarget - tracked < 2) {
							return `<div class="pace-text pace-behind">${(minTarget - tracked).toFixed(1)} hrs below minimum</div>`;
						} else {
							return `<div class="pace-text pace-far-behind">${(minTarget - tracked).toFixed(1)} hrs below minimum</div>`;
						}
					} else {
						const pct =
							expectedHours > 0
								? Math.round((tracked / expectedHours) * 100)
								: 0;
						if (pct >= TARGETS.compliancePercent) {
							return `<div class="pace-text pace-ahead">${pct}% tracked — ${(expectedHours - tracked).toFixed(1)} hrs remaining</div>`;
						} else {
							return `<div class="pace-text pace-behind">${pct}% tracked — target ${TARGETS.compliancePercent}%</div>`;
						}
					}
				})()}
      </div>

      <!-- Card 2: Tier split -->
			${(() => {
				const tierTotal =
					(byTier[1] || 0) + (byTier[2] || 0) + (byTier[3] || 0);
				const t1Pct =
					tierTotal > 0 ? Math.round(((byTier[1] || 0) / tierTotal) * 100) : 0;
				const t2Pct =
					tierTotal > 0 ? Math.round(((byTier[2] || 0) / tierTotal) * 100) : 0;
				const t3Pct = tierTotal > 0 ? 100 - t1Pct - t2Pct : 0;

				return `
			<div class="stat-card">
				<div class="stat-card-label">Time allocation <span class="info-bubble" data-help="How time splits across tiers.<br><br><strong>Tier 1 (purple):</strong> Customer-facing work like migrations, hardware, API work, merchant meetings<br><strong>Tier 2 (green):</strong> Internal work like admin, internal meetings, research, tools<br><strong>Tier 3 (grey):</strong> Other">i</span></div>
				${
					tierTotal > 0
						? `
				<div style="display: flex; height: 14px; border-radius: 4px; overflow: hidden; margin: 8px 0 10px;">
					${t1Pct > 0 ? `<div style="width: ${t1Pct}%; background: var(${TIERS[1].hexVar}); opacity: 0.7; border-right: 1px solid var(--bg-card);"></div>` : ""}
					${t2Pct > 0 ? `<div style="width: ${t2Pct}%; background: var(${TIERS[2].hexVar}); opacity: 0.7; border-right: 1px solid var(--bg-card);"></div>` : ""}
					${t3Pct > 0 ? `<div style="width: ${t3Pct}%; background: var(${TIERS[3].hexVar}); opacity: 0.7;"></div>` : ""}
				</div>
				<div style="display: flex; flex-direction: column; gap: 3px;">
					<div style="display: flex; justify-content: space-between; font-size: 11px;">
						<span style="display: flex; align-items: center; gap: 4px;">
							<span style="width: 6px; height: 6px; border-radius: 2px; background: var(${TIERS[1].hexVar});"></span>
							<span style="color: var(--text-muted);">Customer</span>
						</span>
						<span style="font-weight: 500;">${t1Pct}%</span>
					</div>
					<div style="display: flex; justify-content: space-between; font-size: 11px;">
						<span style="display: flex; align-items: center; gap: 4px;">
							<span style="width: 6px; height: 6px; border-radius: 2px; background: var(${TIERS[2].hexVar});"></span>
							<span style="color: var(--text-muted);">Internal</span>
						</span>
						<span style="font-weight: 500;">${t2Pct}%</span>
					</div>
					<div style="display: flex; justify-content: space-between; font-size: 11px;">
						<span style="display: flex; align-items: center; gap: 4px;">
							<span style="width: 6px; height: 6px; border-radius: 2px; background: var(${TIERS[3].hexVar});"></span>
							<span style="color: var(--text-muted);">Other</span>
						</span>
						<span style="font-weight: 500;">${t3Pct}%</span>
					</div>
				</div>
        `
						: `
				<div style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">No tiered time this period</div>
        `
				}
			</div>`;
			})()}

      <!-- Card 3: Billable ratio -->
      ${(() => {
				const billablePct =
					tracked > 0 ? Math.round((billable / tracked) * 100) : 0;

				return `
      <div class="stat-card">
        <div class="stat-card-label">Billable ratio <span class="info-bubble" data-help="Percentage of tracked hours marked as billable. Billable work is any work done for a specific customer that does not include work that benefits other customers. For example, meetings or tickets for a merchant are billable, however working on a bug that impacts multiple merchants is not.">i</span></div>
        <div style="display: flex; align-items: baseline; gap: 6px; margin-top: 6px;">
          <div class="stat-card-value">${billablePct}%</div>
          <span style="font-size: 12px; color: var(--text-muted);">${billable} of ${tracked} hrs</span>
        </div>
        <div style="height: 6px; border-radius: 3px; background: var(--progress-track); margin-top: 8px; overflow: hidden;">
          <div style="height: 100%; width: ${Math.max(billablePct, 2)}%; border-radius: 3px; background: ${billable > 0 ? "var(--positive)" : "var(--text-placeholder)"};"></div>
        </div>
        ${billable === 0 ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">No billable hours this period</div>` : ""}
      </div>`;
			})()}

      <!-- Card 4: Top category -->
      ${(() => {
				/* Find the category with the most hours (excluding lunch, OOO) */
				const catEntries = Object.entries(byCategory)
					.filter(([id]) => id !== "lunch" && id !== "ooo")
					.sort((a, b) => b[1] - a[1]);

				if (catEntries.length === 0) {
					return `
      <div class="stat-card">
        <div class="stat-card-label">Top category <span class="info-bubble" data-help="The category consuming the most time this period, with the runner-up shown below.">i</span></div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">No data this period</div>
      </div>`;
				}

				const [topId, topHours] = catEntries[0];
				const topCat = CATEGORIES.find((c) => c.id === topId);
				const catTotal = catEntries.reduce((sum, [, hrs]) => sum + hrs, 0);
				const topPct =
					catTotal > 0 ? Math.round((topHours / catTotal) * 100) : 0;

				/* Check if there's a close second */
				const hasSecond = catEntries.length > 1;
				const [secondId, secondHours] = hasSecond ? catEntries[1] : ["", 0];
				const secondCat = hasSecond
					? CATEGORIES.find((c) => c.id === secondId)
					: null;
				const secondPct =
					catTotal > 0 ? Math.round((secondHours / catTotal) * 100) : 0;

				return `
      <div class="stat-card">
        <div class="stat-card-label">Top category <span class="info-bubble" data-help="The category consuming the most time this period, with the runner-up shown below.">i</span></div>
        <div style="display: flex; align-items: center; gap: 6px; margin-top: 6px;">
          <div style="width: 8px; height: 8px; border-radius: 2px; background: var(${topCat?.cssVar || "--cat-other-border"}); flex-shrink: 0;"></div>
          <span style="font-size: 13px; font-weight: 500;">${topCat?.label || topId}</span>
        </div>
        <div style="font-size: 18px; font-weight: 500; margin-top: 4px;">${topPct}%<span style="font-size: 12px; font-weight: 400; color: var(--text-muted);"> (${topHours} hrs)</span></div>
        ${
					hasSecond
						? `
        <div style="display: flex; align-items: center; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 0.5px solid var(--border-default);">
          <div style="width: 6px; height: 6px; border-radius: 2px; background: var(${secondCat?.cssVar || "--cat-other-border"}); flex-shrink: 0;"></div>
          <span style="font-size: 11px; color: var(--text-muted);">${secondCat?.label || secondId} — ${secondPct}% (${secondHours} hrs)</span>
        </div>
        `
						: ""
				}
				
      </div>`;
			})()}

      ${(() => {
				if (
					ticketStats.length === 0 ||
					selectedMember === "all" ||
					selectedMember === "self"
				)
					return "";

				const sorted = ticketStats.sort((a, b) => a.date.localeCompare(b.date));
				const last = sorted[sorted.length - 1];
				const totalNew = ticketStats.reduce(
					(sum, s) => sum + (s.newTickets || 0),
					0,
				);
				const totalClosed = ticketStats.reduce(
					(sum, s) => sum + (s.closedTickets || 0),
					0,
				);
				const currentQueue =
					last.queueSize + last.newTickets - last.closedTickets;
				const net = totalNew - totalClosed;
				const netColor =
					net > 0
						? "var(--danger)"
						: net < 0
							? "var(--positive)"
							: "var(--text-muted)";
				const netPrefix = net > 0 ? "+" : "";

				return `
        <div class="stat-card">
          <div class="stat-card-label">Ticket queue</div>
          <div style="font-size: 22px; font-weight: 600; color: var(--text-primary); margin-top: 4px;">${currentQueue}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">open tickets</div>
          <div style="display: flex; gap: 10px; margin-top: 8px; font-size: 11px;">
            <span style="color: var(--text-secondary);">${totalNew} new</span>
            <span style="color: var(--text-secondary);">${totalClosed} closed</span>
            <span style="font-weight: 500; color: ${netColor};">${netPrefix}${net} net</span>
          </div>
        </div>
        `;
			})()}

    </div>

	${
		appState.settings.role === "manager" && selectedMember === "all"
			? `
    <!-- ================================================================
      TEAM ALERTS
      ================================================================ -->
    <div class="mb-6 p-4 rounded-xl border border-stone-100 bg-white">
      ${await (async () => {
				const alerts = await renderTeamAlerts(entries, expectedHours);
				if (alerts.length === 0) {
					return '<div style="font-size: 12px; color: var(--text-muted);">No alerts — team is on track.</div>';
				}
				return `
          <div class="text-sm font-medium mb-3">Team alerts <span class="info-bubble" data-help="Auto-generated alerts based on team data.<br><br><strong>Below target:</strong> Member tracking below 60% of expected hours<br><strong>Category concentration:</strong> Over 30% of time in one category<br><strong>Outliers:</strong> Members significantly above or below team average<br><strong>Lunch compliance:</strong> Members skipping lunch 2+ days">i</span></div>
          ${alerts
						.map(
							(a) => `
            <div class="insight-card insight-${a.type}">
              <div class="insight-icon" style="background: ${
								a.type === "warning"
									? "var(--warning)"
									: a.type === "flag"
										? "var(--danger)"
										: a.type === "concentration"
											? "var(--accent)"
											: "var(--info)"
							}">${a.type === "flag" ? "!" : a.type === "warning" ? "!" : "i"}</div>
              <div>${a.message}</div>
            </div>
          `,
						)
						.join("")}
        `;
			})()}
    </div>

    <!-- ================================================================
      TEAM COMPLIANCE TABLE
      ================================================================ -->
    <div class="mb-6 p-4 rounded-xl border border-stone-100 bg-white">
      ${renderTeamComplianceTable(entries, expectedHours)}
    </div>

    <!-- ================================================================
      OUTSOURCING CANDIDATES
      ================================================================ -->
    ${(() => {
			const outsourcingHtml = renderOutsourcingCandidates(entries);
			return outsourcingHtml
				? `
    <div class="mb-6 p-4 rounded-xl border border-stone-100 bg-white">
      ${outsourcingHtml}
    </div>
      `
				: "";
		})()}

	<!-- ================================================================
      TICKET QUEUE
      ================================================================ -->
    ${(() => {
			const ticketHtml = renderTicketOverview(ticketStats, queueDaysByMember);
			return ticketHtml
				? `
    <div class="mb-6 p-4 rounded-xl border border-stone-100 bg-white">
      ${ticketHtml}
    </div>
      `
				: "";
		})()}

    <!-- ================================================================
      CATEGORY HEATMAP
      ================================================================ -->
    ${(() => {
			const heatmapHtml = renderCategoryHeatmap(entries, queueDaysByMember);
			return heatmapHtml
				? `
    <div class="mb-6 p-4 rounded-xl border border-stone-100 bg-white">
      ${heatmapHtml}
    </div>
      `
				: "";
		})()}
    `
			: ""
	}

	

    <!-- ================================================================
      ROW 2: Hours by area + Urgent / Disproportionate flags
      ================================================================ -->
    ${(() => {
			const hasFlags = flaggedMerchants.length > 0 || flaggedPOS.length > 0;
			const hasRightContent = true; /* Urgent card always shows */

			return `
    <div class="grid grid-cols-2 gap-4 mb-6">

      <!-- Hours by area donut (left) -->
      <div class="p-4 rounded-xl border border-stone-100 bg-white" style="display: flex; flex-direction: column;">
        <div class="text-sm font-medium mb-3">Hours by area <span class="info-bubble" data-help="Breakdown of time across work categories, excluding lunch and OOO. Hover a segment for exact hours and percentage.">i</span></div>
        <div class="chart-container" style="flex: 1; min-height: 220px;">
          <canvas id="chart-category"></canvas>
        </div>
      </div>

      <!-- Urgent + flags (right, stacked) -->
      <div class="flex flex-col gap-4">

        <!-- Urgent flag frequency -->
        <div class="p-4 rounded-xl border border-stone-100 bg-white" ${!hasFlags ? 'style="flex: 1;"' : ""}>
          <div class="text-sm font-medium mb-3">Urgent work <span class="info-bubble" data-help="Percentage of tracked hours marked as urgent i.e. unplanned reactive work that interrupted planned tasks. <strong>Above 20%</strong> suggests too much time on emergencies.">i</span></div>
          ${
						urgentHours > 0
							? `
          <div style="display: flex; align-items: baseline; gap: 6px;">
            <span style="font-size: 20px; font-weight: 500;">${urgentPct}%</span>
            <span style="font-size: 12px; color: var(--text-muted);">${urgentHours} hrs flagged urgent</span>
          </div>
          <div style="height: 6px; border-radius: 3px; background: var(--progress-track); margin-top: 8px; overflow: hidden;">
            <div style="height: 100%; width: ${urgentPct}%; border-radius: 3px; background: var(--danger); opacity: 0.7;"></div>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">${urgentPct > 20 ? "High reactive workload — consider proactive planning" : urgentPct > 10 ? "Moderate urgency level" : "Low urgency — mostly planned work"}</div>
          `
							: `
          <div style="display: flex; align-items: baseline; gap: 6px;">
            <span style="font-size: 20px; font-weight: 500; color: var(--text-muted);">0%</span>
            <span style="font-size: 12px; color: var(--text-muted);">No urgent blocks this period</span>
          </div>
          `
					}
        </div>

        ${
					flaggedMerchants.length > 0
						? `
        <!-- Flagged merchants -->
        <div class="p-4 rounded-xl border border-stone-100 bg-white" style="border-left: 3px solid var(--warning);">
          <div style="font-size: 11px; font-weight: 500; color: var(--warning); margin-bottom: 6px;">Merchant concentration</div>
          ${flaggedMerchants
						.map(
							(m) => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 3px 0;">
              <span style="font-size: 13px; font-weight: 500;">${m.name}</span>
              <span style="font-size: 12px; color: var(--text-muted);">${m.hours} hrs (${m.percentage}%)</span>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">${m.reason}</div>
          `,
						)
						.join("")}
        </div>
        `
						: ""
				}

        ${
					flaggedPOS.length > 0
						? `
        <!-- Flagged POS -->
        <div class="p-4 rounded-xl border border-stone-100 bg-white" style="border-left: 3px solid var(--warning);">
          <div style="font-size: 11px; font-weight: 500; color: var(--warning); margin-bottom: 6px;">POS concentration</div>
          ${flaggedPOS
						.map(
							(p) => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 3px 0;">
              <span style="font-size: 13px; font-weight: 500;">${p.name}</span>
              <span style="font-size: 12px; color: var(--text-muted);">${p.hours} hrs (${p.percentage}%)</span>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">${p.reason}</div>
          `,
						)
						.join("")}
        </div>
        `
						: ""
				}

      </div>
    </div>`;
		})()}

    <!-- ================================================================
      ROW 3: Daily breakdown + Merchant / POS tables
      ================================================================ -->
    ${(() => {
			const isAllTeam =
				appState.settings.role === "manager" && selectedMember === "all";

			if (isAllTeam) {
				/* Manager "All team" view — merchant and POS side by side, no daily breakdown */
				const teamMerchantHtml = renderTeamMerchantTable(entries);
				const teamPOSHtml = renderTeamPOSTable(entries);

				if (!teamMerchantHtml && !teamPOSHtml) return "";

				const hasBoth = teamMerchantHtml && teamPOSHtml;

				return `
      <div class="${hasBoth ? "grid grid-cols-2 gap-4" : ""} mb-6">
        ${
					teamMerchantHtml
						? `
        <div class="p-4 rounded-xl border border-stone-100 bg-white">
          ${teamMerchantHtml}
        </div>
        `
						: ""
				}
        ${
					teamPOSHtml
						? `
        <div class="p-4 rounded-xl border border-stone-100 bg-white">
          ${teamPOSHtml}
        </div>
        `
						: ""
				}
      </div>`;
			} else {
				/* Individual view — daily breakdown + merchant/POS stacked */
				const showMerchant =
					Object.keys(byMerchant).length > 0 &&
					(selectedMember !== "self" || appState.settings.enableMerchant);
				const showPOS =
					Object.keys(byPOS).length > 0 &&
					(selectedMember !== "self" || appState.settings.enableFormerPOS);
				const hasRightColumn = showMerchant || showPOS;

				return `
      <div class="${hasRightColumn ? "grid grid-cols-2 gap-4" : ""} mb-6">

        <div class="p-4 rounded-xl border border-stone-100 bg-white">
          <div class="text-sm font-medium mb-3">${currentPeriod === "weekly" ? "Daily breakdown" : "Average day breakdown"}</div>
          <div class="chart-container" style="height: ${hasRightColumn ? "100%" : "220px"}; min-height: 220px;">
            <canvas id="chart-daily"></canvas>
          </div>
        </div>

        ${
					hasRightColumn
						? `
        <div class="flex flex-col gap-4">
          ${
						showMerchant
							? `
          <div class="p-4 rounded-xl border border-stone-100 bg-white" style="flex: 1;">
            ${renderMerchantTable(byMerchant, tracked)}
          </div>
          `
							: ""
					}
          ${
						showPOS
							? `
          <div class="p-4 rounded-xl border border-stone-100 bg-white" style="flex: 1;">
            ${renderPOSTable(byPOS, tracked)}
          </div>
          `
							: ""
					}
        </div>
        `
						: ""
				}

      </div>`;
			}
		})()}

    <!-- ================================================================
      ROW 4: Weekly trend (monthly+ only, 3+ weeks)
      ================================================================ -->
    ${
			history.length >= 3 && currentPeriod !== "weekly"
				? `
    <div class="p-4 rounded-xl border border-stone-100 bg-white mb-6">
      <div class="text-sm font-medium mb-3">Weekly trend — past ${history.length} weeks</div>
      <div class="chart-container" style="height: 200px;">
        <canvas id="chart-trend"></canvas>
      </div>
      <div class="flex gap-4 mt-2">
        <div class="flex items-center gap-1.5 text-xs text-stone-400">
          <div class="w-4 h-0.5 rounded" style="background: var(--accent);"></div>Tracked hours
        </div>
        <div class="flex items-center gap-1.5 text-xs text-stone-400">
          <div class="w-4 h-0.5 rounded" style="background: var(--warning); border-top: 1px dashed var(--warning);"></div>Billable hours
        </div>
      </div>
    </div>
    `
				: currentPeriod !== "weekly"
					? `
    <div class="p-4 rounded-xl border border-stone-100 bg-white mb-6">
      <div class="text-sm font-medium mb-3">Weekly trend</div>
      <div class="flex items-center justify-center" style="height: 120px; color: var(--text-muted); font-size: 13px;">
        Trends will appear once you have 3+ completed weeks of data.
      </div>
    </div>
    `
					: ""
		}

    <!-- ================================================================
      ROW 5: Category proportion trend (monthly+ only, 3+ weeks)
      ================================================================ -->
    ${
			history.length >= 3 && currentPeriod !== "weekly"
				? `
    <div class="p-4 rounded-xl border border-stone-100 bg-white mb-6">
      <div class="text-sm font-medium mb-3">Category trends — past ${history.length} weeks</div>
      <div class="chart-container" style="height: 220px;">
        <canvas id="chart-category-trend"></canvas>
      </div>
    </div>
    `
				: ""
		}
	`;

	/* Render Chart.js charts after DOM is ready */
	renderCategoryChart(byCategory);
	const isAllTeam =
		appState.settings.role === "manager" && selectedMember === "all";
	if (!isAllTeam) renderDailyChart(entries, range);
	if (history.length >= 3 && currentPeriod !== "weekly") {
		renderTrendChart(history);
		renderCategoryTrendChart(history);
	}

	/* Attach event listeners */
	attachStatsListeners();
}

/**
 * renderTeamComplianceTable
 * Shows every team member's tracking compliance, tier split, and hours.
 */
function renderTeamComplianceTable(teamEntries, expectedHours) {
	const range = getPeriodRange();

	/* Group entries by member */
	const byMember = {};
	teamEntries.forEach((e) => {
		const name = e.memberName || "Unknown";
		if (!byMember[name]) byMember[name] = [];
		byMember[name].push(e);
	});

	const tierMap = appState.tierMap || {};
	const rows = [];

	for (const [name, memberEntries] of Object.entries(byMember)) {
		const tracked = countTrackedHours(memberEntries);
		const billable = countBillableHours(memberEntries);
		const byTier = aggregateByTier(memberEntries, tierMap);
		const tierTotal = (byTier[1] || 0) + (byTier[2] || 0) + (byTier[3] || 0);
		const t1Pct =
			tierTotal > 0 ? Math.round(((byTier[1] || 0) / tierTotal) * 100) : 0;
		const t2Pct =
			tierTotal > 0 ? Math.round(((byTier[2] || 0) / tierTotal) * 100) : 0;
		/* Calculate per-member expected hours independently */
		const memberOOO = getOOODatesFromEntries(memberEntries);
		const startHour = appState.settings.dayStartHour || 8;
		const memberFirstDate =
			memberEntries
				.map((e) => e.date)
				.filter(Boolean)
				.sort()[0] || range.startDate;
		const effectiveStart =
			memberFirstDate > range.startDate ? memberFirstDate : range.startDate;
		const memberExpected = countExpectedHoursUpToNow(
			effectiveStart,
			range.endDate,
			TARGETS.dailyTrackableHours,
			memberOOO,
			startHour,
		);
		const compliancePct =
			memberExpected > 0 ? Math.round((tracked / memberExpected) * 100) : 0;

		/* Calculate lunch compliance — how many tracked days included lunch */
		const memberDates = [...new Set(memberEntries.map((e) => e.date))];
		const trackedDays = memberDates.filter((date) => {
			const dayEntries = memberEntries.filter((e) => e.date === date);
			return dayEntries.some((e) => e.category && e.category !== "ooo");
		});
		const lunchDays = trackedDays.filter((date) => {
			const dayEntries = memberEntries.filter((e) => e.date === date);
			return dayEntries.some((e) => e.category === "lunch");
		});
		const lunchRatio =
			trackedDays.length > 0 ? lunchDays.length / trackedDays.length : 0;

		rows.push({
			name,
			tracked,
			billable,
			byTier,
			t1Pct,
			t2Pct,
			compliancePct,
			lunchDays: lunchDays.length,
			trackedDays: trackedDays.length,
			lunchRatio,
		});
	}

	/* Sort by name */
	rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

	let html = `
    <div class="text-sm font-medium mb-3">Team compliance <span class="info-bubble" data-help="<strong>Tracked:</strong> Total hours logged<br><strong>Compliance:</strong> Tracked vs expected (green ≥60%, red <42%)<br><strong>Billable:</strong> Billable hours<br><strong>Tier 1:</strong> Customer-facing work percentage<br><strong>Lunch:</strong> Days with lunch logged vs total tracked days">i</span></div>
    <div style="overflow-x: auto;">
    <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
      <thead>
        <tr style="border-bottom: 1px solid var(--border-default);">
          <th style="text-align: left; padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px;">Name</th>
          <th style="text-align: right; padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px;">Tracked</th>
          <th style="text-align: right; padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px;">Compliance</th>
          <th style="text-align: right; padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px;">Billable</th>
          <th style="text-align: right; padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px;">Tier 1</th>
          <th style="text-align: center; padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px;">Lunch</th>
          <th style="padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px; width: 120px;">Tier split</th>
        </tr>
      </thead>
      <tbody>
  `;

	rows.forEach((r) => {
		const complianceColor =
			r.compliancePct >= 60
				? "var(--positive)"
				: r.compliancePct >= 42
					? "var(--warning)"
					: "var(--danger)";
		const initials = r.name
			.split(" ")
			.map((n) => n[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);

		html += `
        <tr style="border-bottom: 0.5px solid var(--border-default); cursor: pointer;" class="team-member-row" data-member="${r.name}">
          <td style="padding: 8px 6px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div style="width: 26px; height: 26px; border-radius: 50%; background: var(--accent-light); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 500; color: var(--accent-text);">${initials}</div>
              <span style="font-weight: 500; color: var(--accent-text);">${r.name}</span>
            </div>
          </td>
          <td style="text-align: right; padding: 8px 6px;">${r.tracked} hrs</td>
          <td style="text-align: right; padding: 8px 6px;">
            <span style="color: ${complianceColor}; font-weight: 500;">${r.compliancePct}%</span>
          </td>
          <td style="text-align: right; padding: 8px 6px;">${r.billable} hrs</td>
          <td style="text-align: right; padding: 8px 6px;">${r.t1Pct}%</td>
          <td style="text-align: center; padding: 8px 6px;">
            <span style="font-size: 11px; font-weight: 500; color: ${r.lunchRatio >= 0.8 ? "var(--positive)" : r.lunchRatio >= 0.5 ? "var(--warning)" : "var(--danger)"};">
              ${r.lunchDays}/${r.trackedDays}
            </span>
          </td>
          <td style="padding: 8px 6px;">
            <div style="display: flex; height: 6px; border-radius: 3px; overflow: hidden;">
              ${r.t1Pct > 0 ? `<div style="width: ${r.t1Pct}%; background: var(${TIERS[1].hexVar}); opacity: 0.7;"></div>` : ""}
              ${r.t2Pct > 0 ? `<div style="width: ${r.t2Pct}%; background: var(${TIERS[2].hexVar}); opacity: 0.7;"></div>` : ""}
              ${100 - r.t1Pct - r.t2Pct > 0 ? `<div style="width: ${100 - r.t1Pct - r.t2Pct}%; background: var(${TIERS[3].hexVar}); opacity: 0.7;"></div>` : ""}
            </div>
          </td>
        </tr>
    `;
	});

	html += "</tbody></table></div>";
	return html;
}

/**
 * renderTeamAlerts
 * Generates auto-detected alerts across the team.
 */
async function renderTeamAlerts(teamEntries, expectedHours) {
	const alerts = [];
	const tierMap = appState.tierMap || {};

	/* Group entries by member */
	const byMember = {};
	teamEntries.forEach((e) => {
		const name = e.memberName || "Unknown";
		if (!byMember[name]) byMember[name] = [];
		byMember[name].push(e);
	});

	/* Check compliance per member */
	const belowTarget = [];
	for (const [name, memberEntries] of Object.entries(byMember)) {
		const tracked = countTrackedHours(memberEntries);
		const memberOOO = getOOODatesFromEntries(memberEntries);
		const startHour = appState.settings.dayStartHour || 8;
		const range = getPeriodRange();
		const memberFirstDate =
			memberEntries
				.map((e) => e.date)
				.filter(Boolean)
				.sort()[0] || range.startDate;
		const effectiveStart =
			memberFirstDate > range.startDate ? memberFirstDate : range.startDate;
		const memberExpected = countExpectedHoursUpToNow(
			effectiveStart,
			range.endDate,
			TARGETS.dailyTrackableHours,
			memberOOO,
			startHour,
		);
		const compliancePct =
			memberExpected > 0 ? Math.round((tracked / memberExpected) * 100) : 0;
		if (compliancePct < TARGETS.compliancePercent) {
			belowTarget.push({ name, compliancePct });
		}
	}

	if (belowTarget.length > 0) {
		const names = belowTarget
			.map((m) => `${m.name} (${m.compliancePct}%)`)
			.join(", ");
		alerts.push({
			type: "flag",
			message: `<strong>Below target:</strong> ${names}`,
		});
	}

	/* ================================================================
	 * WORKLOAD & SPECIALIZATION ALERTS
	 *   1. Concentration — fires if personal share ≥50% OR peer ≥3× median
	 *   2. Coverage risk — ≥60% of category total, ≤2 people, ≥5h material
	 * ================================================================ */

	/* Proportional minimum — ~12.5% of expected hours per person */
	const teamSize = Object.keys(byMember).length;
	const proportionalMin =
		teamSize > 0
			? Math.max(2, Math.round((expectedHours * 0.125) / teamSize))
			: 2;

	/* Build per-person per-category hours matrix */
	const personCatHours = {};
	const personTotals = {};
	const catTotals = {};
	const catParticipants = {};

	for (const [name, memberEntries] of Object.entries(byMember)) {
		personCatHours[name] = {};
		let total = 0;

		memberEntries.forEach((e) => {
			if (!e.category || e.category === "lunch" || e.category === "ooo") return;
			personCatHours[name][e.category] =
				(personCatHours[name][e.category] || 0) + 0.5;
			catTotals[e.category] = (catTotals[e.category] || 0) + 0.5;
			total += 0.5;
		});

		personTotals[name] = total;
	}

	/* Build participant lists per category (non-zero only) */
	for (const [name, cats] of Object.entries(personCatHours)) {
		for (const [catId, hours] of Object.entries(cats)) {
			if (hours > 0) {
				if (!catParticipants[catId]) catParticipants[catId] = [];
				catParticipants[catId].push({ name, hours });
			}
		}
	}

	/* Helper: calculate median of an array of numbers */
	function median(arr) {
		if (arr.length === 0) return 0;
		const sorted = [...arr].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 !== 0
			? sorted[mid]
			: (sorted[mid - 1] + sorted[mid]) / 2;
	}

	/* --- Concentration alerts --- */
	const concentrationAlerts = [];

	for (const [name, cats] of Object.entries(personCatHours)) {
		const personTotal = personTotals[name];
		if (personTotal === 0) continue;

		for (const [catId, hours] of Object.entries(cats)) {
			if (hours < proportionalMin) continue;

			const cat = CATEGORIES.find((c) => c.id === catId);
			const catLabel = cat?.label || catId;
			const pctOfPerson = Math.round((hours / personTotal) * 100);

			/* Check personal share — ≥50% of person's tracked time */
			const isPersonalHigh = pctOfPerson >= 50;

			/* Check peer multiple — ≥3× median of non-zero peers, ≥3 people */
			let isPeerHigh = false;
			let peerMultiple = 0;
			const participants = catParticipants[catId] || [];
			if (participants.length >= 3) {
				const peerHours = participants
					.filter((p) => p.name !== name)
					.map((p) => p.hours);
				const peerMedian = median(peerHours);
				if (peerMedian > 0) {
					peerMultiple = Math.round((hours / peerMedian) * 10) / 10;
					isPeerHigh = peerMultiple >= 3;
				}
			}

			/* Fire if EITHER condition holds */
			if (isPersonalHigh || isPeerHigh) {
				concentrationAlerts.push({
					name,
					catLabel,
					pct: pctOfPerson,
					multiple: isPeerHigh ? peerMultiple : 0,
					hasBoth: isPersonalHigh && isPeerHigh,
					hasPersonal: isPersonalHigh,
					hasPeer: isPeerHigh,
				});
			}
		}
	}

	/* Add concentration alerts */
	concentrationAlerts.forEach((a) => {
		let msg;
		if (a.hasBoth) {
			msg = `<strong>Concentration:</strong> ${a.name} — ${a.catLabel} is ${a.pct}% of their time (${a.multiple}× team median)`;
		} else if (a.hasPersonal) {
			msg = `<strong>Concentration:</strong> ${a.name} — ${a.catLabel} is ${a.pct}% of their tracked time`;
		} else {
			msg = `<strong>Concentration:</strong> ${a.name} — ${a.catLabel} at ${a.multiple}× the team median`;
		}
		alerts.push({ type: "concentration", message: msg });
	});

	/* --- Coverage risk alerts --- */
	for (const [catId, participants] of Object.entries(catParticipants)) {
		const catTotal = catTotals[catId] || 0;
		if (catTotal < 5) continue;
		if (participants.length > 2) continue;

		const cat = CATEGORIES.find((c) => c.id === catId);
		const catLabel = cat?.label || catId;

		for (const p of participants) {
			const pctOfCategory = Math.round((p.hours / catTotal) * 100);
			if (pctOfCategory >= 60) {
				alerts.push({
					type: "info",
					message: `<strong>Coverage risk:</strong> ${p.name} handles ${pctOfCategory}% of all ${catLabel} — only ${participants.length} ${participants.length === 1 ? "person does" : "people do"} this (${catTotal}h total)`,
				});
			}
		}
	}

	/* Lunch compliance check */
	const now = new Date();
	const todayStr = now.toISOString().slice(0, 10);
	const isPast3pm = now.getHours() >= 15;
	const lunchSkippers = [];

	for (const [name, memberEntries] of Object.entries(byMember)) {
		const dates = [...new Set(memberEntries.map((e) => e.date))];
		const daysWithoutLunch = dates.filter((date) => {
			const dayEntries = memberEntries.filter((e) => e.date === date);
			const hasLunch = dayEntries.some((e) => e.category === "lunch");
			const hasWork = dayEntries.some(
				(e) => e.category && e.category !== "lunch" && e.category !== "ooo",
			);

			/* For today, only count as missed if it's after 3pm */
			if (date === todayStr && !isPast3pm) return false;

			return hasWork && !hasLunch;
		});

		if (daysWithoutLunch.length >= 2) {
			lunchSkippers.push(`${name} (${daysWithoutLunch.length} days)`);
		}
	}

	if (lunchSkippers.length > 0) {
		alerts.push({
			type: "warning",
			message: `<strong>Skipped lunch:</strong> ${lunchSkippers.join(", ")}`,
		});
	}

	/* Overtime check — flag members over 40h/week */
	const {
		getWeekDates: getWeekDatesUtil,
		formatDateISO: fmtISO,
		getISOWeekKey: getWeekKey,
	} = await import("./utils.js");

	/* Get entries grouped by member and week */
	const overtimeWarnings = [];
	const overtimeDangers = [];

	for (const [name, memberEntries] of Object.entries(byMember)) {
		/* Group this member's entries by week */
		const byWeek = {};
		memberEntries.forEach((e) => {
			if (!e.date || e.category === "ooo") return;
			const weekKey = getWeekKey(new Date(e.date));
			if (!byWeek[weekKey]) byWeek[weekKey] = 0;
			byWeek[weekKey] += 0.5;
		});

		/* Find weeks over 40h */
		const overWeeks = Object.entries(byWeek)
			.filter(([, hrs]) => hrs > 40)
			.map(([wk]) => wk)
			.sort();

		if (overWeeks.length === 0) continue;

		/* Check for consecutive weeks */
		let hasConsecutive = false;
		for (let i = 1; i < overWeeks.length; i++) {
			const prev = overWeeks[i - 1];
			const curr = overWeeks[i];
			/* Parse week numbers to check if consecutive */
			const [, prevW] = prev.split("-W").map(Number);
			const [, currW] = curr.split("-W").map(Number);
			if (currW === prevW + 1) {
				hasConsecutive = true;
				break;
			}
		}

		/* If only one week in the period, check the previous week from team data */
		if (overWeeks.length === 1) {
			const currentWeekKey = overWeeks[0];
			const [yearStr, weekStr] = currentWeekKey.split("-W");
			const prevWeekNum = parseInt(weekStr) - 1;
			const prevWeekKey =
				prevWeekNum > 0
					? `${yearStr}-W${String(prevWeekNum).padStart(2, "0")}`
					: null;

			if (prevWeekKey) {
				try {
					const { getTeamMemberData } = await import("./db.js");
					const prevEntries = await getTeamMemberData(
						name,
						`${yearStr}-01-01`,
						`${yearStr}-12-31`,
					);
					const prevWeekHours =
						prevEntries.filter(
							(e) =>
								getWeekKey(new Date(e.date)) === prevWeekKey &&
								e.category !== "ooo",
						).length * 0.5;
					if (prevWeekHours > 40) {
						hasConsecutive = true;
					}
				} catch (e) {
					/* ignore */
				}
			}
		}

		const totalOverHours = overWeeks
			.map((wk) => byWeek[wk])
			.reduce((s, h) => s + h, 0);
		const avgOver =
			Math.round((totalOverHours / overWeeks.length - 40) * 10) / 10;

		if (hasConsecutive) {
			overtimeDangers.push(
				`${name} (${avgOver}h+ over, ${overWeeks.length} weeks)`,
			);
		} else {
			overtimeWarnings.push(`${name} (${avgOver}h+ over)`);
		}
	}

	if (overtimeDangers.length > 0) {
		alerts.push({
			type: "flag",
			message: `<strong>Consecutive overtime:</strong> ${overtimeDangers.join(", ")}`,
		});
	}
	if (overtimeWarnings.length > 0) {
		alerts.push({
			type: "warning",
			message: `<strong>Over 40h this week:</strong> ${overtimeWarnings.join(", ")}`,
		});
	}

	/* No hours logged — red flag for members with zero tracked time */
	const noHoursMembers = [];
	for (const [name, memberEntries] of Object.entries(byMember)) {
		const tracked =
			memberEntries.filter(
				(e) => e.category && e.category !== "ooo" && e.category !== "lunch",
			).length * 0.5;
		if (tracked === 0) {
			noHoursMembers.push(name);
		}
	}

	if (noHoursMembers.length > 0) {
		alerts.push({
			type: "flag",
			message: `<strong>No hours logged:</strong> ${noHoursMembers.join(", ")}`,
		});
	}

	return alerts;
}

/**
 * renderOutsourcingCandidates
 * Shows the top 3 categories by team hours with FTE equivalents.
 * Helps managers identify work that could be delegated to other teams.
 */
function renderOutsourcingCandidates(entries) {
	const byCategory = aggregateByCategory(entries);

	/* Sort categories by hours descending, exclude lunch and OOO */
	const sorted = Object.entries(byCategory)
		.filter(([id]) => id !== "lunch" && id !== "ooo")
		.filter(([, hours]) => hours / 40 >= 0.75)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3);

	if (sorted.length === 0) return "";

	/* Group entries by member for each category to show distribution */
	const byMember = {};
	entries.forEach((e) => {
		if (!e.memberName) return;
		if (!byMember[e.memberName]) byMember[e.memberName] = {};
		if (!byMember[e.memberName][e.category])
			byMember[e.memberName][e.category] = 0;
		byMember[e.memberName][e.category] += 0.5;
	});

	const memberCount = Object.keys(byMember).length;

	let html = '<div class="text-sm font-medium mb-3">Full-Time Candidates</div>';
	html += '<div style="display: flex; gap: 12px;">';

	sorted.forEach(([catId, hours]) => {
		const cat = CATEGORIES.find((c) => c.id === catId);
		const tierMap = appState.tierMap || {};
		const tier = tierMap[catId];
		const tierLabel =
			tier === 1
				? "Tier 1"
				: tier === 2
					? "Tier 2"
					: tier === 3
						? "Tier 3"
						: "";
		const fte = (hours / 40).toFixed(1);

		/* Count how many members contribute to this category */
		const contributors = Object.entries(byMember)
			.filter(([, cats]) => (cats[catId] || 0) > 0)
			.sort((a, b) => (b[1][catId] || 0) - (a[1][catId] || 0));

		const isSpread = contributors.length >= Math.ceil(memberCount * 0.5);

		html += `
      <div style="flex: 1; padding: 14px; border-radius: 10px; background: var(--bg-surface); border: 0.5px solid var(--border-default);">
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
          <div style="width: 8px; height: 8px; border-radius: 2px; background: var(${cat?.cssVar || "--cat-other-border"}); flex-shrink: 0;"></div>
          <span style="font-size: 13px; font-weight: 500; color: var(--text-primary);">${cat?.label || catId}</span>
        </div>

        <div style="font-size: 22px; font-weight: 500; color: var(--text-primary);">${hours}<span style="font-size: 12px; font-weight: 400; color: var(--text-muted);"> hrs/period</span></div>

        <div style="display: flex; gap: 8px; margin-top: 8px; margin-bottom: 8px;">
          <span style="font-size: 11px; color: var(--accent-text); background: var(--accent-light); padding: 2px 8px; border-radius: 4px;">${fte} FTE</span>
          ${tierLabel ? `<span style="font-size: 11px; color: var(--text-muted); background: var(--bg-card); padding: 2px 8px; border-radius: 4px; border: 0.5px solid var(--border-default);">${tierLabel}</span>` : ""}
        </div>

        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px;">
          ${
						isSpread
							? `Spread across ${contributors.length} of ${memberCount} members`
							: `Concentrated in ${contributors.length} member${contributors.length > 1 ? "s" : ""}`
					}
        </div>

        <div style="display: flex; flex-wrap: wrap; gap: 3px;">
          ${contributors
						.slice(0, 4)
						.map(([name, cats]) => {
							const initials = name
								.split(" ")
								.map((n) => n[0])
								.join("")
								.toUpperCase()
								.slice(0, 2);
							const memberHrs = cats[catId] || 0;
							return `<span style="font-size: 10px; color: var(--text-muted); background: var(--bg-card); padding: 2px 6px; border-radius: 4px; border: 0.5px solid var(--border-default);">${initials} ${memberHrs}h</span>`;
						})
						.join("")}
          ${contributors.length > 4 ? `<span style="font-size: 10px; color: var(--text-placeholder);">+${contributors.length - 4}</span>` : ""}
        </div>
      </div>
    `;
	});

	html += "</div>";
	return html;
}

/**
 * renderCategoryHeatmap
 * Shows a grid with team members as rows and categories as columns.
 * Cell color intensity indicates hours spent — darker means more time.
 * Helps managers spot specialization patterns at a glance.
 */
function renderCategoryHeatmap(entries, queueDaysByMember = {}) {
	/* Group entries by member */
	const byMember = {};
	entries.forEach((e) => {
		if (!e.memberName || !e.category) return;
		if (e.category === "lunch" || e.category === "ooo") return;
		if (!byMember[e.memberName]) byMember[e.memberName] = {};
		if (!byMember[e.memberName][e.category])
			byMember[e.memberName][e.category] = 0;
		byMember[e.memberName][e.category] += 0.5;
	});

	const members = Object.keys(byMember).sort((a, b) =>
		a.toLowerCase().localeCompare(b.toLowerCase()),
	);

	if (members.length === 0) return "";

	/* Get active categories (any category that has hours across the team) */
	const activeCatIds = new Set();
	members.forEach((name) => {
		Object.keys(byMember[name]).forEach((catId) => {
			if (byMember[name][catId] > 0) activeCatIds.add(catId);
		});
	});

	const activeCats = CATEGORIES.filter((c) => activeCatIds.has(c.id));
	if (activeCats.length === 0) return "";

	/* Find the max hours in any single cell for scaling intensity */
	let maxHours = 0;
	members.forEach((name) => {
		activeCats.forEach((cat) => {
			const hrs = byMember[name]?.[cat.id] || 0;
			if (hrs > maxHours) maxHours = hrs;
		});
	});

	/* Intensity function: returns opacity 0.0 to 1.0 */
	function intensity(hours) {
		if (maxHours === 0 || hours === 0) return 0;
		/* Use square root scale so low values are still visible */
		return Math.sqrt(hours / maxHours);
	}

	/* Short category labels for column headers */
	function shortLabel(label) {
		const map = {
			"Admin — Internal": "Admin int",
			"Admin — Merchant": "Admin merch",
			"Analytics Support": "Analytics",
			"API / Technical Scoping": "API",
			"Data Migration / Cleaning": "Migration",
			"Hardware Support": "Hardware",
			"Internal Tools Dev": "Tools",
			"Live Meeting — Internal": "Mtg int",
			"Live Meeting — Merchant": "Mtg merch",
			"Research / Product Sync": "Research",
			Other: "Other",
		};
		return map[label] || label;
	}

	let html = `
    <div class="text-sm font-medium mb-3">Category heatmap <span class="info-bubble" data-help="Hours per category per team member. Darker cells = more time spent. Click a row to drill into that person's stats. Bottom row shows team totals.">i</span></div>
    <div style="overflow-x: auto;">
    <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
      <thead>
        <tr>
          <th style="text-align: left; padding: 6px 8px; font-weight: 500; color: var(--text-muted); font-size: 10px; min-width: 100px;"></th>
          ${activeCats
						.map(
							(cat) => `
            <th style="text-align: center; padding: 6px 4px; font-weight: 500; color: var(--text-muted); font-size: 10px; min-width: 50px;">
              <div style="display: flex; flex-direction: column; align-items: center; gap: 2px;">
                <div style="width: 6px; height: 6px; border-radius: 2px; background: var(${cat.cssVar});"></div>
                ${shortLabel(cat.label)}
              </div>
            </th>
          `,
						)
						.join("")}
          <th style="text-align: right; padding: 6px 8px; font-weight: 500; color: var(--text-muted); font-size: 10px;">Total</th>
        </tr>
      </thead>
      <tbody>
  `;

	members.forEach((name) => {
		const initials = name
			.split(" ")
			.map((n) => n[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);
		const memberTotal = Object.values(byMember[name] || {}).reduce(
			(sum, h) => sum + h,
			0,
		);

		html += `
      <tr style="border-top: 0.5px solid var(--border-default); cursor: pointer;" class="team-member-row" data-member="${name}">
        <td style="padding: 6px 8px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <div style="width: 22px; height: 22px; border-radius: 50%; background: var(--accent-light); display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 500; color: var(--accent-text);">${initials}</div>
            <span style="font-weight: 500; font-size: 11px; color: var(--accent-text);">${name}</span>
            ${queueDaysByMember[name] > 0 ? `<span class="queue-pill">Queue: ${queueDaysByMember[name]}d</span>` : ""}
          </div>
        </td>
    `;

		activeCats.forEach((cat) => {
			const hrs = byMember[name]?.[cat.id] || 0;
			const opac = intensity(hrs);

			html += `
        <td style="text-align: center; padding: 4px;">
          <div style="
            border-radius: 4px;
            padding: 4px 2px;
            font-size: 10px;
            font-weight: ${hrs > 0 ? "500" : "400"};
            color: ${hrs > 0 ? "var(--text-primary)" : "var(--text-placeholder)"};
            background: ${hrs > 0 ? `color-mix(in srgb, var(${cat.cssVar}) ${Math.round(opac * 40 + 10)}%, transparent)` : "none"};
          ">${hrs > 0 ? hrs : ""}</div>
        </td>
      `;
		});

		html += `
        <td style="text-align: right; padding: 6px 8px; font-weight: 500; font-size: 11px;">${memberTotal}h</td>
      </tr>
    `;
	});

	/* Team totals row */
	html += `
    <tr style="border-top: 1px solid var(--border-default);">
      <td style="padding: 6px 8px; font-weight: 500; font-size: 11px; color: var(--text-muted);">Team total</td>
  `;

	let grandTotal = 0;
	activeCats.forEach((cat) => {
		const catTotal = members.reduce(
			(sum, name) => sum + (byMember[name]?.[cat.id] || 0),
			0,
		);
		grandTotal += catTotal;
		html += `
      <td style="text-align: center; padding: 6px 4px; font-weight: 500; font-size: 11px; color: var(--text-muted);">${catTotal > 0 ? catTotal : ""}</td>
    `;
	});

	html += `
      <td style="text-align: right; padding: 6px 8px; font-weight: 500; font-size: 11px; color: var(--text-primary);">${grandTotal}h</td>
    </tr>
  `;

	html += "</tbody></table></div>";
	return html;
}

/**
 * renderTicketOverview
 * Shows ticket queue data for the team or individual member.
 * Displays current queue, new tickets, closed tickets, and net change.
 */
function renderTicketOverview(ticketStats, queueDaysByMember = {}) {
	if (!ticketStats || ticketStats.length === 0) return "";

	const isAllTeam =
		appState.settings.role === "manager" && selectedMember === "all";

	if (isAllTeam) {
		/* Group by member */
		const byMember = {};
		ticketStats.forEach((s) => {
			if (!byMember[s.memberName]) byMember[s.memberName] = [];
			byMember[s.memberName].push(s);
		});

		const rows = Object.entries(byMember)
			.map(([name, stats]) => {
				/* Sort by date to find first and last */
				const sorted = stats.sort((a, b) => a.date.localeCompare(b.date));
				const first = sorted[0];
				const last = sorted[sorted.length - 1];

				/* Starting queue = first day's base queue size */
				const startQueue = first.queueSize;
				/* Total new and closed across all days */
				const totalNew = stats.reduce((sum, s) => sum + (s.newTickets || 0), 0);
				const totalClosed = stats.reduce(
					(sum, s) => sum + (s.closedTickets || 0),
					0,
				);
				/* Current queue = last day's computed queue */
				const currentQueue =
					last.queueSize + last.newTickets - last.closedTickets;
				const net = totalNew - totalClosed;

				return { name, startQueue, currentQueue, totalNew, totalClosed, net };
			})
			.sort((a, b) => a.name.localeCompare(b.name));

		/* Team totals */
		const teamNew = rows.reduce((s, r) => s + r.totalNew, 0);
		const teamClosed = rows.reduce((s, r) => s + r.totalClosed, 0);
		const teamQueue = rows.reduce((s, r) => s + r.currentQueue, 0);
		const teamNet = teamNew - teamClosed;

		let html = `
      <div class="text-sm font-medium mb-3">Ticket queue <span class="info-bubble" data-help="Each member's open ticket count, new tickets received, tickets closed, and net change. <strong>Red net</strong> = queue growing. <strong>Green net</strong> = queue shrinking.">i</span></div>
      <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
        <thead>
          <tr>
            <th style="text-align: left; padding: 6px 8px; font-weight: 500; color: var(--text-muted); font-size: 10px;">Name</th>
            <th style="text-align: right; padding: 6px 8px; font-weight: 500; color: var(--text-muted); font-size: 10px;">Queue</th>
            <th style="text-align: right; padding: 6px 8px; font-weight: 500; color: var(--text-muted); font-size: 10px;">New</th>
            <th style="text-align: right; padding: 6px 8px; font-weight: 500; color: var(--text-muted); font-size: 10px;">Closed</th>
            <th style="text-align: right; padding: 6px 8px; font-weight: 500; color: var(--text-muted); font-size: 10px;">Net</th>
          </tr>
        </thead>
        <tbody>
    `;

		rows.forEach((r) => {
			const netColor =
				r.net > 0
					? "var(--danger)"
					: r.net < 0
						? "var(--positive)"
						: "var(--text-muted)";
			const netPrefix = r.net > 0 ? "+" : "";
			const initials = r.name
				.split(" ")
				.map((n) => n[0])
				.join("")
				.toUpperCase()
				.slice(0, 2);

			html += `
        <tr style="border-top: 0.5px solid var(--border-default); cursor: pointer;" class="team-member-row" data-member="${r.name}">
          <td style="padding: 6px 8px;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <div style="width: 20px; height: 20px; border-radius: 50%; background: var(--accent-light); display: flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 500; color: var(--accent-text);">${initials}</div>
              <div>
                <span style="font-weight: 500; color: var(--text-primary);">${r.name}</span>
                ${queueDaysByMember[r.name] > 0 ? `<div style="font-size: 10px; color: var(--teal-text); margin-top: 1px;">Queue: ${queueDaysByMember[r.name]}d</div>` : ""}
              </div>
            </div>
          </td>
          <td style="text-align: right; padding: 6px 8px; font-weight: 500;">${r.currentQueue}</td>
          <td style="text-align: right; padding: 6px 8px;">${r.totalNew}</td>
          <td style="text-align: right; padding: 6px 8px;">${r.totalClosed}</td>
          <td style="text-align: right; padding: 6px 8px; font-weight: 500; color: ${netColor};">${netPrefix}${r.net}</td>
        </tr>
      `;
		});

		/* Team totals row */
		const teamNetColor =
			teamNet > 0
				? "var(--danger)"
				: teamNet < 0
					? "var(--positive)"
					: "var(--text-muted)";
		const teamNetPrefix = teamNet > 0 ? "+" : "";

		html += `
        <tr style="border-top: 1px solid var(--border-default);">
          <td style="padding: 6px 8px; font-weight: 500; color: var(--text-muted);">Team total</td>
          <td style="text-align: right; padding: 6px 8px; font-weight: 600;">${teamQueue}</td>
          <td style="text-align: right; padding: 6px 8px; font-weight: 500;">${teamNew}</td>
          <td style="text-align: right; padding: 6px 8px; font-weight: 500;">${teamClosed}</td>
          <td style="text-align: right; padding: 6px 8px; font-weight: 600; color: ${teamNetColor};">${teamNetPrefix}${teamNet}</td>
        </tr>
      </tbody></table>
    `;

		return html;
	} else {
		/* Individual member view — summary card */
		const sorted = ticketStats.sort((a, b) => a.date.localeCompare(b.date));
		const last = sorted[sorted.length - 1];
		const totalNew = ticketStats.reduce(
			(sum, s) => sum + (s.newTickets || 0),
			0,
		);
		const totalClosed = ticketStats.reduce(
			(sum, s) => sum + (s.closedTickets || 0),
			0,
		);
		const currentQueue = last.queueSize + last.newTickets - last.closedTickets;
		const net = totalNew - totalClosed;
		const netColor =
			net > 0
				? "var(--danger)"
				: net < 0
					? "var(--positive)"
					: "var(--text-muted)";
		const netPrefix = net > 0 ? "+" : "";

		return `
      <div class="text-sm font-medium mb-3">Ticket queue</div>
      <div style="display: flex; gap: 16px;">
        <div>
          <div style="font-size: 10px; color: var(--text-muted);">Current queue</div>
          <div style="font-size: 20px; font-weight: 600; color: var(--text-primary);">${currentQueue}</div>
        </div>
        <div>
          <div style="font-size: 10px; color: var(--text-muted);">New</div>
          <div style="font-size: 20px; font-weight: 600; color: var(--text-primary);">${totalNew}</div>
        </div>
        <div>
          <div style="font-size: 10px; color: var(--text-muted);">Closed</div>
          <div style="font-size: 20px; font-weight: 600; color: var(--text-primary);">${totalClosed}</div>
        </div>
        <div>
          <div style="font-size: 10px; color: var(--text-muted);">Net</div>
          <div style="font-size: 20px; font-weight: 600; color: ${netColor};">${netPrefix}${net}</div>
        </div>
      </div>
    `;
	}
}

/**
 * renderTeamMerchantTable
 * Shows merchant time aggregated across the team with member attribution.
 * Only shown in "All team" view when merchant data exists.
 */
function renderTeamMerchantTable(entries) {
	/* Aggregate merchant hours across team */
	const merchantData = {};
	entries.forEach((e) => {
		if (!e.merchant || !e.merchant.trim()) return;
		const name = e.merchant.trim();
		if (!merchantData[name]) merchantData[name] = { hours: 0, members: {} };
		merchantData[name].hours += 0.5;
		if (e.memberName) {
			if (!merchantData[name].members[e.memberName])
				merchantData[name].members[e.memberName] = 0;
			merchantData[name].members[e.memberName] += 0.5;
		}
	});

	const sorted = Object.entries(merchantData).sort(
		(a, b) => b[1].hours - a[1].hours,
	);
	if (sorted.length === 0) return "";

	const merchantTotal = sorted.reduce((sum, [, data]) => sum + data.hours, 0);
	const maxHours = sorted[0][1].hours;

	let html =
		'<div class="text-sm font-medium mb-3">Merchant time - team <span class="info-bubble" data-help="Total hours spent per merchant across the team. Badges show which members contributed and their hours. Merchants consuming over <strong>15% of total time</strong> with 4+ hours are flagged.">i</span></div>';
	html += '<div class="space-y-2">';

	sorted.slice(0, 10).forEach(([name, data]) => {
		const pct =
			merchantTotal > 0 ? Math.round((data.hours / merchantTotal) * 100) : 0;
		const barWidth = Math.round((data.hours / maxHours) * 100);
		const memberList = Object.entries(data.members).sort((a, b) => b[1] - a[1]);

		html += `
      <div>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-stone-500 w-28 truncate" style="font-weight: 500;">${name}</span>
          <div class="flex-1 h-2 bg-stone-50 rounded-full overflow-hidden">
            <div class="h-full rounded-full bg-chronos-200" style="width: ${barWidth}%"></div>
          </div>
          <span class="font-medium w-12 text-right">${data.hours} hrs</span>
          <span class="text-stone-400 w-8 text-right">${pct}%</span>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; padding-left: 120px;">
          ${memberList
						.map(([member, hrs]) => {
							return `<span style="font-size: 9px; color: var(--text-muted); background: var(--bg-surface); padding: 1px 5px; border-radius: 3px;">${member} ${hrs}h</span>`;
						})
						.join("")}
        </div>
      </div>
    `;
	});

	if (sorted.length > 10) {
		const remainingHours = sorted
			.slice(10)
			.reduce((s, [, d]) => s + d.hours, 0);
		html += `
      <div class="text-xs text-stone-400 pt-1">
        + ${sorted.length - 10} more merchants (${remainingHours} hrs)
      </div>
    `;
	}

	html += "</div>";
	return html;
}

/**
 * renderTeamPOSTable
 * Shows POS time aggregated across the team with member attribution.
 * Only shown in "All team" view when POS data exists.
 */
function renderTeamPOSTable(entries) {
	/* Aggregate POS hours across team */
	const posData = {};
	entries.forEach((e) => {
		if (!e.formerPOS || !e.formerPOS.trim()) return;
		const name = e.formerPOS.trim();
		if (!posData[name])
			posData[name] = { hours: 0, members: {}, merchants: new Set() };
		posData[name].hours += 0.5;
		if (e.memberName) {
			if (!posData[name].members[e.memberName])
				posData[name].members[e.memberName] = 0;
			posData[name].members[e.memberName] += 0.5;
		}
		if (e.merchant && e.merchant.trim()) {
			posData[name].merchants.add(e.merchant.trim());
		}
	});

	const sorted = Object.entries(posData).sort(
		(a, b) => b[1].hours - a[1].hours,
	);
	if (sorted.length === 0) return "";

	const posTotal = sorted.reduce((sum, [, data]) => sum + data.hours, 0);
	const maxHours = sorted[0][1].hours;

	let html =
		'<div class="text-sm font-medium mb-3">POS platforms — team <span class="info-bubble" data-help="Total hours spent per POS platform across the team. Shows how many merchants use each platform. Platforms consuming over <strong>25% of total time</strong> with 4+ hours are flagged.">i</span></div>';
	html += '<div class="space-y-2">';

	sorted.slice(0, 8).forEach(([name, data]) => {
		const pct = posTotal > 0 ? Math.round((data.hours / posTotal) * 100) : 0;
		const barWidth = Math.round((data.hours / maxHours) * 100);
		const memberList = Object.entries(data.members).sort((a, b) => b[1] - a[1]);
		const merchantCount = data.merchants.size;

		html += `
      <div>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-stone-500 w-28 truncate" style="font-weight: 500;">${name}</span>
          <div class="flex-1 h-2 bg-stone-50 rounded-full overflow-hidden">
            <div class="h-full rounded-full bg-chronos-200" style="width: ${barWidth}%"></div>
          </div>
          <span class="font-medium w-12 text-right">${data.hours} hrs</span>
          <span class="text-stone-400 w-8 text-right">${pct}%</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; margin-top: 3px; padding-left: 120px;">
          <span style="font-size: 9px; color: var(--text-placeholder);">${merchantCount} merchant${merchantCount > 1 ? "s" : ""}</span>
          ${memberList
						.map(([member, hrs]) => {
							return `<span style="font-size: 9px; color: var(--text-muted); background: var(--bg-surface); padding: 1px 5px; border-radius: 3px;">${member} ${hrs}h</span>`;
						})
						.join("")}
        </div>
      </div>
    `;
	});

	if (sorted.length > 8) {
		const remainingHours = sorted.slice(8).reduce((s, [, d]) => s + d.hours, 0);
		html += `
      <div class="text-xs text-stone-400 pt-1">
        + ${sorted.length - 8} more systems (${remainingHours} hrs)
      </div>
    `;
	}

	html += "</div>";
	return html;
}

/* ============================================================================
 * HELPER RENDERERS
 * ========================================================================= */

/**
 * renderTierBar
 * Generates the inline HTML for the horizontal stacked tier bar.
 */
function renderTierBar(byTier, total) {
	/* Calculate tier-only total (excludes lunch/OOO which have null tier) */
	const tierTotal = (byTier[1] || 0) + (byTier[2] || 0) + (byTier[3] || 0);

	if (tierTotal === 0) {
		return '<div class="flex-1 bg-stone-100 flex items-center justify-center text-xs text-stone-400">No data</div>';
	}

	return [1, 2, 3]
		.map((t) => {
			const hours = byTier[t] || 0;
			const pct = Math.round((hours / tierTotal) * 100);
			if (pct === 0) return "";
			return `
        <div class="flex items-center justify-center text-xs font-medium"
            style="width: ${pct}%; background: var(${TIERS[t].bgVar}); color: var(${TIERS[t].hexVar});">
            ${pct >= 10 ? `${pct}%` : ""}
        </div>
    `;
		})
		.join("");
}

/**
 * renderMerchantTable
 * Generates the merchant time breakdown table.
 */
function renderMerchantTable(byMerchant, total) {
	const sorted = Object.entries(byMerchant).sort((a, b) => b[1] - a[1]);

	/* Calculate percentage against merchant time only, not all tracked time */
	const merchantTotal = sorted.reduce((sum, [, hours]) => sum + hours, 0);

	const topMerchants = sorted.slice(0, 8);
	const remaining = sorted.slice(8);
	const remainingHours = remaining.reduce((s, [, h]) => s + h, 0);
	const maxHours = topMerchants.length > 0 ? topMerchants[0][1] : 1;

	let html =
		'<div class="text-sm font-medium mb-3">Merchant time <span class="info-bubble" data-help="Hours spent per merchant this period. Merchants consuming over <strong>15% of total merchant time</strong> with 4+ hours are flagged as disproportionate.">i</span></div>';
	html += '<div class="space-y-1.5">';

	topMerchants.forEach(([name, hours]) => {
		const pct =
			merchantTotal > 0 ? Math.round((hours / merchantTotal) * 100) : 0;
		const barWidth = Math.round((hours / maxHours) * 100);
		html += `
      <div class="flex items-center gap-2 text-xs">
        <span class="text-stone-500 w-28 truncate">${name}</span>
        <div class="flex-1 h-2 bg-stone-50 rounded-full overflow-hidden">
          <div class="h-full rounded-full bg-chronos-200" style="width: ${barWidth}%"></div>
        </div>
        <span class="font-medium w-12 text-right">${hours} hrs</span>
        <span class="text-stone-400 w-8 text-right">${pct}%</span>
      </div>
    `;
	});

	if (remaining.length > 0) {
		html += `
      <div class="text-xs text-stone-400 pt-1">
        + ${remaining.length} more merchants (${remainingHours} hrs)
      </div>
    `;
	}

	html += "</div>";
	return html;
}

/**
 * renderPOSTable
 * Generates the Former POS time breakdown table.
 */
function renderPOSTable(byPOS, total) {
	const sorted = Object.entries(byPOS).sort((a, b) => b[1] - a[1]);

	const posTotal = sorted.reduce((sum, [, hours]) => sum + hours, 0);

	const topItems = sorted.slice(0, 8);
	const remaining = sorted.slice(8);
	const remainingHours = remaining.reduce((s, [, h]) => s + h, 0);
	const maxHours = topItems.length > 0 ? topItems[0][1] : 1;

	let html =
		'<div class="text-sm font-medium mb-3">Time by former POS <span class="info-bubble" data-help="Hours spent per POS platform this period. Platforms consuming over <strong>25% of total POS time</strong> with 4+ hours are flagged.">i</span></div>';
	html += '<div class="space-y-1.5">';

	topItems.forEach(([name, hours]) => {
		const pct = posTotal > 0 ? Math.round((hours / posTotal) * 100) : 0;
		const barWidth = Math.round((hours / maxHours) * 100);
		html += `
      <div class="flex items-center gap-2 text-xs">
        <span class="text-stone-500 w-28 truncate">${name}</span>
        <div class="flex-1 h-2 bg-stone-50 rounded-full overflow-hidden">
          <div class="h-full rounded-full bg-chronos-200" style="width: ${barWidth}%"></div>
        </div>
        <span class="font-medium w-12 text-right">${hours} hrs</span>
        <span class="text-stone-400 w-8 text-right">${pct}%</span>
      </div>
    `;
	});

	if (remaining.length > 0) {
		html += `
      <div class="text-xs text-stone-400 pt-1">
        + ${remaining.length} more systems (${remainingHours} hrs)
      </div>
    `;
	}

	html += "</div>";
	return html;
}

/**
 * renderBillableBreakdown
 * Shows billable vs non-billable time when merchant tracking is off.
 */
function renderBillableBreakdown(entries, total) {
	const billableHours = countBillableHours(entries);
	const nonBillable = total - billableHours;
	const billablePct = total > 0 ? Math.round((billableHours / total) * 100) : 0;

	return `
    <div class="text-sm font-medium mb-3">Billable breakdown</div>
    <div class="flex items-center gap-4 mb-4">
      <div class="flex-1">
        <div class="text-2xl font-semibold text-emerald-600">${billableHours}</div>
        <div class="text-xs text-stone-400">Billable hours (${billablePct}%)</div>
      </div>
      <div class="flex-1">
        <div class="text-2xl font-semibold text-stone-400">${nonBillable.toFixed(1)}</div>
        <div class="text-xs text-stone-400">Non-billable hours</div>
      </div>
    </div>
    <div class="flex h-4 rounded-full overflow-hidden">
      <div class="bg-emerald-200" style="width: ${billablePct}%"></div>
      <div class="bg-stone-100" style="width: ${100 - billablePct}%"></div>
    </div>
  `;
}

/**
 * getExpectedHours
 * Returns the expected trackable hours for the current period,
 * only counting days/hours up to now. Future days are not included.
 * OOO days are excluded. First tracked date is derived from the
 * entries themselves, not the local database.
 *
 * @param {Array<Object>} entries - Entries for the period (needed to detect OOO days)
 * @param {Array<Object>} allAvailableEntries - All entries to find first tracked date (optional)
 * @returns {Promise<number>} Expected trackable hours up to now
 */
async function getExpectedHours(entries = [], allAvailableEntries = null) {
	const range = getPeriodRange();
	const oooDates = getOOODatesFromEntries(entries);
	const startHour = appState.settings.dayStartHour || 8;

	/* Find first tracked date from the appropriate source */
	let firstDate;
	if (selectedMember === "self") {
		/* Own data — use local database */
		firstDate = await getFirstTrackedDate();
	} else if (allAvailableEntries && allAvailableEntries.length > 0) {
		/* Team data — find earliest date from the entries */
		firstDate =
			allAvailableEntries
				.map((e) => e.date)
				.filter(Boolean)
				.sort()[0] || null;
	} else {
		firstDate = null;
	}

	const effectiveStart =
		firstDate && firstDate > range.startDate ? firstDate : range.startDate;

	return countExpectedHoursUpToNow(
		effectiveStart,
		range.endDate,
		TARGETS.dailyTrackableHours,
		oooDates,
		startHour,
	);
}

/**
 * countWeekdaysInRange
 * Counts the number of weekdays (Mon-Fri) between two dates.
 */
function countWeekdaysInRange(startStr, endStr) {
	const start = parseDate(startStr);
	const end = parseDate(endStr);
	let count = 0;
	const d = new Date(start);
	while (d <= end) {
		const day = d.getDay();
		if (day !== 0 && day !== 6) count++;
		d.setDate(d.getDate() + 1);
	}
	return count;
}

/**
 * getDaysInPeriod
 * Returns a human-readable label for the number of days in the period.
 */
function getDaysInPeriod() {
	const range = getPeriodRange();
	const days = countWeekdaysInRange(range.startDate, range.endDate);
	return days;
}

/* ============================================================================
 * CHART.JS RENDERERS
 * ========================================================================= */

/**
 * renderCategoryChart
 * Draws a donut chart showing hours by work category.
 */
function renderCategoryChart(byCategory) {
	const canvas = document.getElementById("chart-category");
	if (!canvas) return;

	/* Filter to categories that have hours, sorted descending */
	const data = CATEGORIES.filter(
		(cat) =>
			(byCategory[cat.id] || 0) > 0 && cat.id !== "ooo" && cat.id !== "lunch",
	).sort((a, b) => (byCategory[b.id] || 0) - (byCategory[a.id] || 0));

	if (data.length === 0) {
		/* No data — show empty state */
		const ctx = canvas.getContext("2d");
		ctx.font = '13px "Plus Jakarta Sans", system-ui, sans-serif';
		ctx.fillStyle = getChartColors().emptyText;
		ctx.textAlign = "center";
		ctx.fillText(
			"No data for this period",
			canvas.width / 2,
			canvas.height / 2,
		);
		return;
	}

	chartInstances.category = new Chart(canvas, {
		type: "doughnut",
		data: {
			labels: data.map((c) => c.label),
			datasets: [
				{
					data: data.map((c) => byCategory[c.id] || 0),
					backgroundColor: data.map((c) => getChartColors().categories[c.id]),
					borderWidth: 0,
					hoverOffset: 4,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			cutout: "60%",
			plugins: {
				legend: {
					position: "right",
					labels: {
						boxWidth: 8,
						boxHeight: 8,
						padding: 8,
						font: {
							size: 11,
							family: '"Plus Jakarta Sans", system-ui, sans-serif',
						},
						color: getChartColors().legendColor,
						usePointStyle: true,
						pointStyleWidth: 8,
					},
				},
				tooltip: {
					callbacks: {
						label: (ctx) =>
							` ${ctx.parsed} hrs (${Math.round((ctx.parsed / data.reduce((s, c) => s + (byCategory[c.id] || 0), 0)) * 100)}%)`,
					},
				},
			},
		},
	});
}

/**
 * renderDailyChart
 * Draws a stacked bar chart showing hours per day (for weekly view)
 * or hours per time block (for daily view).
 */
function renderDailyChart(entries, range) {
	const canvas = document.getElementById("chart-daily");
	if (!canvas) return;

	if (currentPeriod === "daily") {
		/* For daily view, show hours per category as a simple bar */
		const byCategory = aggregateByCategory(entries);
		const data = CATEGORIES.filter(
			(cat) =>
				(byCategory[cat.id] || 0) > 0 && cat.id !== "ooo" && cat.id !== "lunch",
		).sort((a, b) => (byCategory[b.id] || 0) - (byCategory[a.id] || 0));

		chartInstances.daily = new Chart(canvas, {
			type: "bar",
			data: {
				labels: data.map((c) => c.label),
				datasets: [
					{
						data: data.map((c) => byCategory[c.id] || 0),
						backgroundColor: data.map((c) => c.hex),
						borderWidth: 0,
						borderRadius: 4,
					},
				],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				plugins: { legend: { display: false } },
				scales: {
					x: {
						ticks: {
							font: { size: 10 },
							color: getChartColors().tickColor,
							maxRotation: 45,
						},
						grid: { display: false },
					},
					y: {
						ticks: {
							font: { size: 10 },
							color: getChartColors().tickColor,
							callback: (v) => `${v}h`,
						},
						grid: { color: getChartColors().gridColor },
					},
				},
			},
		});
	} else if (currentPeriod === "weekly") {
		/* Weekly view: 5 bars for Mon-Fri of the specific week */
		const weekDates = getWeekDates(periodDate);
		const dayLabels = weekDates.map((d) => formatDateShort(d));

		const byDate = {};
		entries.forEach((e) => {
			if (!byDate[e.date]) byDate[e.date] = [];
			byDate[e.date].push(e);
		});

		const activeCats = CATEGORIES.filter((cat) => {
			return (
				cat.id !== "ooo" &&
				cat.id !== "lunch" &&
				entries.some((e) => e.category === cat.id)
			);
		});

		const datasets = activeCats.map((cat) => ({
			label: cat.label,
			data: weekDates.map((d) => {
				const dateEntries = byDate[formatDateISO(d)] || [];
				return (
					dateEntries.filter((e) => e.category === cat.id).length *
					(TIME_DEFAULTS.blockMinutes / 60)
				);
			}),
			backgroundColor: getChartColors().categories[cat.id],
			borderWidth: 0,
			borderRadius: 2,
		}));

		chartInstances.daily = new Chart(canvas, {
			type: "bar",
			data: { labels: dayLabels, datasets },
			options: {
				responsive: true,
				maintainAspectRatio: false,
				plugins: {
					legend: { display: false },
					tooltip: {
						callbacks: {
							label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y} hrs`,
						},
					},
				},
				scales: {
					x: {
						stacked: true,
						ticks: { font: { size: 11 }, color: getChartColors().tickColor },
						grid: { display: false },
					},
					y: {
						stacked: true,
						ticks: {
							font: { size: 10 },
							color: getChartColors().tickColor,
							callback: (v) => `${v}h`,
						},
						grid: { color: getChartColors().gridColor },
						max: 8,
					},
				},
			},
		});
	} else {
		/* Monthly+ views: aggregate all Mondays, all Tuesdays, etc. */
		const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri"];

		/* Group entries by day of week (1=Mon through 5=Fri) */
		const byDayOfWeek = { 1: [], 2: [], 3: [], 4: [], 5: [] };
		entries.forEach((e) => {
			if (!e.date) return;
			const d = parseDate(e.date);
			const dow = d.getDay(); /* 0=Sun, 1=Mon ... 6=Sat */
			if (dow >= 1 && dow <= 5) {
				byDayOfWeek[dow].push(e);
			}
		});

		/* Count how many of each weekday are in the period for averaging */
		const dayCount = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
		const trackedDates = new Set(entries.map((e) => e.date));
		trackedDates.forEach((dateStr) => {
			const d = parseDate(dateStr);
			const dow = d.getDay();
			if (dow >= 1 && dow <= 5) dayCount[dow]++;
		});

		const activeCats = CATEGORIES.filter((cat) => {
			return (
				cat.id !== "ooo" &&
				cat.id !== "lunch" &&
				entries.some((e) => e.category === cat.id)
			);
		});

		const datasets = activeCats.map((cat) => ({
			label: cat.label,
			data: [1, 2, 3, 4, 5].map((dow) => {
				const dayEntries = byDayOfWeek[dow];
				const totalHours =
					dayEntries.filter((e) => e.category === cat.id).length *
					(TIME_DEFAULTS.blockMinutes / 60);
				/* Average across the number of that weekday in the period */
				const count = dayCount[dow] || 1;
				return parseFloat((totalHours / count).toFixed(1));
			}),
			backgroundColor: getChartColors().categories[cat.id],
			borderWidth: 0,
			borderRadius: 2,
		}));

		/* Calculate max for y-axis from the stacked totals */
		const stackedTotals = [1, 2, 3, 4, 5].map((dow) => {
			return datasets.reduce((sum, ds) => sum + (ds.data[dow - 1] || 0), 0);
		});
		const maxStacked = Math.ceil(Math.max(...stackedTotals, 8));

		chartInstances.daily = new Chart(canvas, {
			type: "bar",
			data: { labels: dayNames, datasets },
			options: {
				responsive: true,
				maintainAspectRatio: false,
				plugins: {
					legend: { display: false },
					tooltip: {
						callbacks: {
							label: (ctx) =>
								` ${ctx.dataset.label}: ${ctx.parsed.y} hrs (avg)`,
						},
					},
				},
				scales: {
					x: {
						stacked: true,
						ticks: { font: { size: 11 }, color: getChartColors().tickColor },
						grid: { display: false },
					},
					y: {
						stacked: true,
						ticks: {
							font: { size: 10 },
							color: getChartColors().tickColor,
							callback: (v) => `${v}h`,
						},
						grid: { color: getChartColors().gridColor },
						max: maxStacked,
					},
				},
			},
		});
	}
}

/**
 * renderTrendChart
 * Draws a line chart showing tracked hours, Tier 1, and billable
 * over the past N weeks.
 */
function renderTrendChart(history) {
	const canvas = document.getElementById("chart-trend");
	if (!canvas) return;

	/* Exclude weeks with 0 tracked hours (e.g., full OOO weeks) */
	const reversed = [...history].filter((w) => w.tracked > 0).reverse();

	chartInstances.trend = new Chart(canvas, {
		type: "line",
		data: {
			labels: reversed.map((w) => w.weekKey.replace(/^\d{4}-/, "")),
			datasets: [
				{
					label: "Tracked hours",
					data: reversed.map((w) => w.tracked),
					borderColor: getChartColors().accent,
					backgroundColor: getChartColors().accentLight,
					fill: true,
					tension: 0.3,
					pointRadius: 3,
					pointBackgroundColor: getChartColors().accent,
					borderWidth: 2,
					order: 2,
				},
				{
					label: "Billable hours",
					data: reversed.map((w) => w.billable || 0),
					borderColor: getChartColors().warning,
					borderDash: [4, 4],
					tension: 0.3,
					pointRadius: 3,
					pointBackgroundColor: getChartColors().warning,
					borderWidth: 1.5,
					fill: false,
					order: 1,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y} hrs`,
					},
				},
			},
			scales: {
				x: {
					ticks: { font: { size: 11 }, color: getChartColors().tickColor },
					grid: { display: false },
				},
				y: {
					ticks: {
						font: { size: 10 },
						color: getChartColors().tickColor,
						callback: (v) => `${v}h`,
					},
					grid: { color: getChartColors().gridColor },
					beginAtZero: true,
				},
			},
		},
	});
}

/**
 * renderCategoryTrendChart
 * Draws a stacked area chart showing how category proportions
 * shift over weeks. Each band is a category as a percentage of total.
 */
function renderCategoryTrendChart(history) {
	const canvas = document.getElementById("chart-category-trend");
	if (!canvas) return;

	const reversed = [...history].filter((w) => w.tracked > 0).reverse();
	if (reversed.length < 3) return;

	/* Get active categories across all weeks */
	const activeCatIds = new Set();
	reversed.forEach((w) => {
		Object.keys(w.byCategory).forEach((id) => {
			if (id !== "lunch" && id !== "ooo") activeCatIds.add(id);
		});
	});

	/* Sort categories by total hours across all weeks */
	const catTotals = {};
	reversed.forEach((w) => {
		for (const id of activeCatIds) {
			catTotals[id] = (catTotals[id] || 0) + (w.byCategory[id] || 0);
		}
	});
	const sortedCats = [...activeCatIds].sort(
		(a, b) => (catTotals[b] || 0) - (catTotals[a] || 0),
	);

	const datasets = sortedCats.map((catId) => {
		const cat = CATEGORIES.find((c) => c.id === catId);
		return {
			label: cat?.label || catId,
			data: reversed.map((w) => {
				const weekTotal = Object.entries(w.byCategory)
					.filter(([id]) => id !== "lunch" && id !== "ooo")
					.reduce((sum, [, hrs]) => sum + hrs, 0);
				return weekTotal > 0
					? Math.round(((w.byCategory[catId] || 0) / weekTotal) * 100)
					: 0;
			}),
			backgroundColor: getChartColors().categories[catId] || "#94A3B8",
			borderWidth: 0,
			fill: true,
		};
	});

	chartInstances.categoryTrend = new Chart(canvas, {
		type: "line",
		data: {
			labels: reversed.map((w) => w.weekKey.replace(/^\d{4}-/, "")),
			datasets,
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: {
					position: "right",
					labels: {
						boxWidth: 8,
						boxHeight: 8,
						padding: 8,
						font: {
							size: 11,
							family: '"Plus Jakarta Sans", system-ui, sans-serif',
						},
						color: getChartColors().legendColor,
						usePointStyle: true,
					},
				},
				tooltip: {
					callbacks: {
						label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y}%`,
					},
				},
			},
			scales: {
				x: {
					ticks: { font: { size: 11 }, color: getChartColors().tickColor },
					grid: { display: false },
				},
				y: {
					stacked: true,
					min: 0,
					max: 100,
					ticks: {
						font: { size: 10 },
						color: getChartColors().tickColor,
						callback: (v) => `${v}%`,
					},
					grid: { color: getChartColors().gridColor },
				},
			},
			elements: {
				line: { tension: 0.3 },
				point: { radius: 0 },
			},
		},
	});
}

/* ============================================================================
 * EVENT LISTENERS
 * ========================================================================= */

function attachStatsListeners() {
	/* Period filter chips */
	document.querySelectorAll(".period-chip").forEach((chip) => {
		chip.addEventListener("click", () => {
			currentPeriod = chip.dataset.period;
			renderStats();
		});
	});

	/* Period navigation arrows */
	document.getElementById("period-prev")?.addEventListener("click", () => {
		navigatePeriod(-1);
		renderStats();
	});
	document.getElementById("period-next")?.addEventListener("click", () => {
		navigatePeriod(1);
		renderStats();
	});

	/* Team member selector */
	document
		.getElementById("team-member-select")
		?.addEventListener("change", (e) => {
			selectedMember = e.target.value;
			renderStats();
		});

	/* Clickable team member names in compliance table */
	document.querySelectorAll(".team-member-row").forEach((row) => {
		row.addEventListener("click", () => {
			selectedMember = row.dataset.member;
			const select = document.getElementById("team-member-select");
			if (select) select.value = selectedMember;
			renderStats();
		});
	});

	/* Notes button */
	document.getElementById("stats-notes-btn")?.addEventListener("click", () => {
		showNotesPanel(appState, periodDate);
	});

	/* Manual "Refresh" button — force an immediate re-import + re-render (managers only). */
	document
		.getElementById("stats-refresh-btn")
		?.addEventListener("click", async (e) => {
			const btn = e.currentTarget;
			btn.disabled = true;
			btn.textContent = "Refreshing…";

			/* forceRender=true so the timestamp updates even when no new data arrived. */
			await refreshTeamData(true);

			/* If renderStats ran, it rebuilt this button fresh and `btn` is now
			 * detached — the check below is a safe no-op. If it didn't run (e.g.
			 * import folder disconnected), restore the original button state. */
			if (document.body.contains(btn)) {
				btn.disabled = false;
				btn.textContent = "Refresh";
			}
		});
}

/**
 * getStatsContext
 * Returns the current stats view context for report generation.
 * Called by app.js when exporting a team report.
 */
export async function getStatsContext() {
	if (!appState) return null;

	const range = getPeriodRange();
	const tierMap = await getTierMap();

	let allEntries;
	if (appState.settings.role === "manager" && selectedMember === "all") {
		allEntries = await getAllTeamEntriesForPeriod(
			range.startDate,
			range.endDate,
		);
	} else if (
		appState.settings.role === "manager" &&
		selectedMember !== "self"
	) {
		allEntries = await getTeamMemberData(
			selectedMember,
			range.startDate,
			range.endDate,
		);
	} else {
		allEntries = await getEntriesForDateRange(range.startDate, range.endDate);
	}

	const entries = filterEntriesUpToNow(allEntries);
	const tracked = countTrackedHours(entries);
	const billable = countBillableHours(entries);
	const byCategory = aggregateByCategory(entries);
	const byTier = aggregateByTier(entries, tierMap);
	const byMerchant = aggregateByMerchant(entries);
	const byPOS = aggregateByPOS(entries);
	const urgentHours = countUrgentHours(entries);
	const urgentPct = tracked > 0 ? Math.round((urgentHours / tracked) * 100) : 0;
	let expectedHours = await getExpectedHours(allEntries, allEntries);

	/* For "All team" view, calculate expected hours per member and sum them */
	if (appState.settings.role === "manager" && selectedMember === "all") {
		const memberNames = [
			...new Set(allEntries.map((e) => e.memberName).filter(Boolean)),
		];
		if (memberNames.length > 0) {
			let totalExpected = 0;
			for (const name of memberNames) {
				const memberEntries = allEntries.filter((e) => e.memberName === name);
				const memberExpected = await getExpectedHours(
					memberEntries,
					memberEntries,
				);
				totalExpected += memberExpected;
			}
			expectedHours = totalExpected;
		}
	}

	const flaggedMerchants =
		Object.keys(byMerchant).length > 0 &&
		(selectedMember !== "self" || appState.settings.enableMerchant)
			? detectDisproportionate(byMerchant, 15, 4)
			: [];
	const flaggedPOS =
		Object.keys(byPOS).length > 0 &&
		(selectedMember !== "self" || appState.settings.enableFormerPOS)
			? detectDisproportionate(byPOS, 25, 4)
			: [];

	/* Build byMember for team reports */
	const byMember = {};
	entries.forEach((e) => {
		const name = e.memberName || "Self";
		if (!byMember[name]) byMember[name] = [];
		byMember[name].push(e);
	});

	return {
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
		byMember,
	};
}
