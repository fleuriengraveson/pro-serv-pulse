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
	const expectedHours = await getExpectedHours(allEntries, allEntries);

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
        <button id="stats-notes-btn" class="sidebar-btn sidebar-btn-notes" style="padding: 5px 12px; font-size: 12px;">
          Notes (N)
        </button>
        <div class="flex items-center gap-2">
          <button id="period-prev"

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
    <div class="grid grid-cols-4 gap-3 mb-6">

		<!-- Card 1: Tracked hours with pace -->
		<div class="stat-card">
			<div class="stat-card-label">Tracked hours</div>
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
				<div class="stat-card-label">Time allocation</div>
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
        <div class="stat-card-label">Billable ratio</div>
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
        <div class="stat-card-label">Top category</div>
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
        <div class="stat-card-label">Top category</div>
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

    </div>

	${
		appState.settings.role === "manager" && selectedMember === "all"
			? `
    <!-- ================================================================
      TEAM ALERTS
      ================================================================ -->
    <div class="mb-6 p-4 rounded-xl border border-stone-100 bg-white">
      ${(() => {
				const alerts = renderTeamAlerts(entries, expectedHours);
				if (alerts.length === 0) {
					return '<div style="font-size: 12px; color: var(--text-muted);">No alerts — team is on track.</div>';
				}
				return `
          <div class="text-sm font-medium mb-3">Team alerts</div>
          ${alerts
						.map(
							(a) => `
            <div class="insight-card insight-${a.type}">
              <div class="insight-icon" style="background: ${
								a.type === "warning"
									? "var(--warning)"
									: a.type === "flag"
										? "var(--danger)"
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
      CATEGORY HEATMAP
      ================================================================ -->
    ${(() => {
			const heatmapHtml = renderCategoryHeatmap(entries);
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
        <div class="text-sm font-medium mb-3">Hours by area</div>
        <div class="chart-container" style="flex: 1; min-height: 220px;">
          <canvas id="chart-category"></canvas>
        </div>
      </div>

      <!-- Urgent + flags (right, stacked) -->
      <div class="flex flex-col gap-4">

        <!-- Urgent flag frequency -->
        <div class="p-4 rounded-xl border border-stone-100 bg-white" ${!hasFlags ? 'style="flex: 1;"' : ""}>
          <div class="text-sm font-medium mb-3">Urgent work</div>
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
          <div class="text-sm font-medium mb-3">Daily breakdown</div>
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
		/* Calculate per-member expected hours accounting for their OOO days */
		const memberOOO = getOOODatesFromEntries(memberEntries);
		const memberExpected =
			expectedHours > 0
				? expectedHours - memberOOO.size * TARGETS.dailyTrackableHours
				: 0;
		const compliancePct =
			memberExpected > 0 ? Math.round((tracked / memberExpected) * 100) : 0;

		rows.push({ name, tracked, billable, byTier, t1Pct, t2Pct, compliancePct });
	}

	/* Sort by name */
	rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

	let html = `
    <div class="text-sm font-medium mb-3">Team compliance</div>
    <div style="overflow-x: auto;">
    <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
      <thead>
        <tr style="border-bottom: 1px solid var(--border-default);">
          <th style="text-align: left; padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px;">Name</th>
          <th style="text-align: right; padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px;">Tracked</th>
          <th style="text-align: right; padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px;">Compliance</th>
          <th style="text-align: right; padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px;">Billable</th>
          <th style="text-align: right; padding: 8px 6px; font-weight: 500; color: var(--text-muted); font-size: 11px;">Tier 1</th>
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
function renderTeamAlerts(teamEntries, expectedHours) {
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
		const pct =
			expectedHours > 0 ? Math.round((tracked / expectedHours) * 100) : 0;
		if (pct < TARGETS.compliancePercent) {
			belowTarget.push({ name, pct });
		}
	}

	if (belowTarget.length > 0) {
		const names = belowTarget.map((m) => `${m.name} (${m.pct}%)`).join(", ");
		alerts.push({
			type: "flag",
			message: `<strong>${belowTarget.length} member${belowTarget.length > 1 ? "s" : ""} below tracking target</strong> — ${names}`,
		});
	}

	/* Check category concentration across team */
	const teamByCategory = aggregateByCategory(teamEntries);
	const totalTeamHours = Object.values(teamByCategory)
		.filter((_, i, arr) => {
			return true;
		})
		.reduce((sum, hrs) => sum + hrs, 0);

	CATEGORIES.forEach((cat) => {
		if (cat.id === "lunch" || cat.id === "ooo") return;
		const hours = teamByCategory[cat.id] || 0;
		const pct =
			totalTeamHours > 0 ? Math.round((hours / totalTeamHours) * 100) : 0;
		if (pct >= 30) {
			alerts.push({
				type: "warning",
				message: `<strong>${cat.label} consuming ${pct}% of team time</strong> — ${hours} total hours across the team.`,
			});
		}
	});

	/* Check for individual outliers in category distribution */
	const memberCount = Object.keys(byMember).length;
	if (memberCount >= 3) {
		CATEGORIES.forEach((cat) => {
			if (cat.id === "lunch" || cat.id === "ooo" || cat.id === "other") return;

			const memberHours = Object.entries(byMember).map(([name, entries]) => ({
				name,
				hours: entries.filter((e) => e.category === cat.id).length * 0.5,
			}));

			const values = memberHours.map((m) => m.hours);
			const mean = calculateMean(values);
			const stdDev = calculateStdDev(values);

			if (stdDev > 0) {
				memberHours.forEach((m) => {
					const deviation = (m.hours - mean) / stdDev;
					if (deviation >= 1.5 && m.hours > 2) {
						const pct =
							totalTeamHours > 0
								? Math.round(
										(m.hours / countTrackedHours(byMember[m.name])) * 100,
									)
								: 0;
						alerts.push({
							type: "info",
							message: `<strong>${m.name} is an outlier on ${cat.label}</strong> — ${pct}% of their time (${m.hours} hrs) vs. team avg of ${mean.toFixed(1)} hrs.`,
						});
					}
				});
			}
		});
	}

	/* Lunch compliance check */
	for (const [name, memberEntries] of Object.entries(byMember)) {
		const dates = [...new Set(memberEntries.map((e) => e.date))];
		const daysWithoutLunch = dates.filter((date) => {
			const dayEntries = memberEntries.filter((e) => e.date === date);
			const hasLunch = dayEntries.some((e) => e.category === "lunch");
			const hasWork = dayEntries.some(
				(e) => e.category && e.category !== "lunch" && e.category !== "ooo",
			);
			return hasWork && !hasLunch;
		});

		if (daysWithoutLunch.length >= 2) {
			alerts.push({
				type: "info",
				message: `<strong>${name} skipped lunch on ${daysWithoutLunch.length} days</strong> this period.`,
			});
		}
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

	const totalTeamHours = sorted.reduce((sum, [, hrs]) => sum + hrs, 0);

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

	let html =
		'<div class="text-sm font-medium mb-3">Potential Outsourcing Candidates</div>';
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
function renderCategoryHeatmap(entries) {
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
			"Admin (Email/Slack)": "Admin",
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
    <div class="text-sm font-medium mb-3">Category heatmap</div>
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

	let html = '<div class="text-sm font-medium mb-3">Merchant time — team</div>';
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
							const initials = member
								.split(" ")
								.map((n) => n[0])
								.join("")
								.toUpperCase()
								.slice(0, 2);
							return `<span style="font-size: 9px; color: var(--text-muted); background: var(--bg-surface); padding: 1px 5px; border-radius: 3px;">${initials} ${hrs}h</span>`;
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

	let html = '<div class="text-sm font-medium mb-3">POS platforms — team</div>';
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
							const initials = member
								.split(" ")
								.map((n) => n[0])
								.join("")
								.toUpperCase()
								.slice(0, 2);
							return `<span style="font-size: 9px; color: var(--text-muted); background: var(--bg-surface); padding: 1px 5px; border-radius: 3px;">${initials} ${hrs}h</span>`;
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

	let html = '<div class="text-sm font-medium mb-3">Merchant time</div>';
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

	let html = '<div class="text-sm font-medium mb-3">Time by former POS</div>';
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
	} else {
		/* For weekly+ views, show stacked bars per day of the week */
		const weekDates = getWeekDates(periodDate);
		const dayLabels = weekDates.map((d) => formatDateShort(d));

		/* Group entries by date */
		const byDate = {};
		entries.forEach((e) => {
			if (!byDate[e.date]) byDate[e.date] = [];
			byDate[e.date].push(e);
		});

		/* Build datasets for each category that has data */
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
		showNotesPanel(appState);
	});
}
