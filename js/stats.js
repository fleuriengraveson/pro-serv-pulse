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
	countTrackedHours,
	countBillableHours,
	countTotalHours,
	detectOutlier,
	getCategoryLabel,
	getCategoryHex,
} from "./utils.js";
import { getChartColors, isDark } from "./theme.js";

/* ============================================================================
 * MODULE STATE
 * ========================================================================= */

let appState = null; // Reference to global app state
let currentPeriod = "weekly"; // Active time filter
let periodDate = new Date(); // The reference date for period navigation
let chartInstances = {}; // Track Chart.js instances for cleanup

/* Period filter options */
const PERIODS = [
	{ id: "daily", label: "Daily" },
	{ id: "weekly", label: "Weekly" },
	{ id: "monthly", label: "Monthly" },
	{ id: "quarterly", label: "Quarterly" },
	{ id: "fy", label: "FY" },
	{ id: "cy", label: "Calendar year" },
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
			const year = d.getFullYear();
			const quarter = Math.floor(d.getMonth() / 3);
			const startMonth = quarter * 3;
			const startDate = formatDateISO(new Date(year, startMonth, 1));
			const endDate = formatDateISO(new Date(year, startMonth + 3, 0));
			const label = `Q${quarter + 1} ${year}`;
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
 * Only includes weeks that fall on or after the user's first ever tracked date.
 *
 * @param {number} numWeeks - Maximum number of historical weeks to fetch
 * @returns {Promise<Array<Object>>} Array of { weekKey, entries, tracked, byCategory, byTier }
 */
async function getHistoricalWeeklyData(numWeeks = 8) {
	const weeks = [];
	const tierMap = await getTierMap();
	const d = new Date(periodDate);
	const firstDate = await getFirstTrackedDate();

	for (let i = 0; i < numWeeks; i++) {
		const refDate = new Date(d);
		refDate.setDate(refDate.getDate() - i * 7);

		const weekDates = getWeekDates(refDate);
		const startDate = formatDateISO(weekDates[0]);
		const endDate = formatDateISO(weekDates[4]);

		/* Stop if this week is entirely before the first tracked date */
		if (firstDate && endDate < firstDate) break;

		const entries = await getEntriesForDateRange(startDate, endDate);

		/* Skip weeks with zero entries — they're gaps, not real data */
		if (entries.length === 0 && i > 0) continue;

		weeks.push({
			weekKey: getISOWeekKey(refDate),
			startDate,
			entries,
			tracked: countTrackedHours(entries),
			billable: countBillableHours(entries),
			byCategory: aggregateByCategory(entries),
			byTier: aggregateByTier(entries, tierMap),
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
	const pastWeeks = history.slice(1).filter((w) => w.tracked > 0);
	const tierMap = appState.tierMap || {};

	/* --- Compliance check --- */
	const trackedPercent =
		TARGETS.weeklyTrackableHours > 0
			? (currentStats.tracked / TARGETS.weeklyTrackableHours) * 100
			: 0;

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
			message: `<strong>Below tracking target</strong> — ${Math.round(trackedPercent)}% tracked vs. the ${TARGETS.compliancePercent}% target. You need ${((TARGETS.compliancePercent / 100) * TARGETS.weeklyTrackableHours - currentStats.tracked).toFixed(1)} more hours.`,
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

/* ============================================================================
 * MAIN RENDER
 * ========================================================================= */

async function renderStats() {
	const container = document.getElementById("view-stats");
	const tierMap = await getTierMap();
	const range = getPeriodRange();

	/* Fetch entries for the current period */
	const entries = await getEntriesForDateRange(range.startDate, range.endDate);

	/* Aggregate stats */
	const tracked = countTrackedHours(entries);
	const total = countTotalHours(entries);
	const billable = countBillableHours(entries);
	const byCategory = aggregateByCategory(entries);
	const byTier = aggregateByTier(entries, tierMap);
	const byMerchant = aggregateByMerchant(entries);
	const untracked = getExpectedHours() - tracked;

	const currentStats = {
		tracked,
		total,
		billable,
		byCategory,
		byTier,
		byMerchant,
	};

	/* Fetch historical data for insights and trend chart */
	const history = await getHistoricalWeeklyData(8);
	const insights = generateInsights(currentStats, history);

	/* Determine compliance status */
	const expectedHours = getExpectedHours();
	const trackedPercent =
		expectedHours > 0 ? Math.round((tracked / expectedHours) * 100) : 0;
	let progressClass = "progress-fill-good";
	if (trackedPercent < TARGETS.compliancePercent) {
		progressClass =
			trackedPercent < TARGETS.compliancePercent * 0.7
				? "progress-fill-bad"
				: "progress-fill-warn";
	}

	/* Historical averages for comparison labels */
	const pastWeeks = history.slice(1);
	const avgTracked =
		pastWeeks.length > 0
			? (
					pastWeeks.reduce((s, w) => s + w.tracked, 0) / pastWeeks.length
				).toFixed(1)
			: null;
	const avgTier1 =
		pastWeeks.length > 0
			? (
					pastWeeks.reduce((s, w) => s + (w.byTier[1] || 0), 0) /
					pastWeeks.length
				).toFixed(1)
			: null;

	/* Tier 1 comparison text */
	const tier1Hours = byTier[1] || 0;
	let tier1Trend = "";
	if (avgTier1 !== null) {
		const diff = (tier1Hours - parseFloat(avgTier1)).toFixed(1);
		if (diff > 0)
			tier1Trend = `<span class="text-emerald-500 text-xs">+${diff} hrs vs. avg</span>`;
		else if (diff < 0)
			tier1Trend = `<span class="text-red-400 text-xs">${diff} hrs vs. avg</span>`;
		else tier1Trend = `<span class="text-stone-400 text-xs">Same as avg</span>`;
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
      <!-- Filter chips -->
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

    <!-- ================================================================
      TOP METRICS ROW
      ================================================================ -->
    <div class="grid grid-cols-4 gap-3 mb-6">
      <!-- Total hours -->
      <div class="stat-card">
        <div class="stat-card-label">Total hours</div>
        <div class="stat-card-value">${total}</div>
        <div class="stat-card-sub">${getDaysInPeriod()} days</div>
      </div>

      <!-- Tracked hours -->
      <div class="stat-card">
        <div class="stat-card-label">Tracked hours</div>
        <div class="stat-card-value">${tracked}</div>
        <div class="progress-track">
          <div class="progress-fill ${progressClass}"
               style="width: ${Math.min(100, trackedPercent)}%"></div>
        </div>
        <div class="stat-card-sub">${trackedPercent}% tracked — target ${TARGETS.compliancePercent}%</div>
      </div>

      <!-- Tier 1 (billable) -->
      <div class="stat-card">
        <div class="stat-card-label">Tier 1 (customer)</div>
        <div class="stat-card-value">${tier1Hours}<span class="text-sm font-normal text-stone-400"> hrs</span></div>
        ${tier1Trend ? `<div class="mt-1">${tier1Trend}</div>` : ""}
      </div>

      <!-- Untracked -->
      <div class="stat-card">
        <div class="stat-card-label">Untracked hours</div>
        <div class="stat-card-value">${Math.max(0, untracked).toFixed(1)}</div>
        <div class="stat-card-sub">${avgTracked ? `Avg tracked: ${avgTracked} hrs` : ""}</div>
      </div>
    </div>

    <!-- ================================================================
      INSIGHTS PANEL
      ================================================================ -->
    <div class="mb-6 p-4 rounded-xl border border-stone-100 bg-white">
      <div class="text-sm font-medium mb-3">Insights this period</div>
      ${
				insights.length > 0
					? insights
							.map(
								(ins) => `
          <div class="insight-card insight-${ins.type}">
            <div class="insight-icon" style="background: ${
							ins.type === "warning"
								? "var(--warning)"
								: ins.type === "positive"
									? "var(--positive)"
									: ins.type === "flag"
										? "var(--danger)"
										: "var(--info)"
						}">${ins.icon}</div>
            <div>${ins.message}</div>
          </div>
        `,
							)
							.join("")
					: '<div class="text-sm text-stone-400">No entries for this period yet.</div>'
			}
    </div>

    <!-- ================================================================
      CHARTS ROW 1: Hours by area + Tier breakdown
      ================================================================ -->
    <div class="grid grid-cols-2 gap-4 mb-6">

      <!-- Hours by area donut -->
      <div class="p-4 rounded-xl border border-stone-100 bg-white">
        <div class="text-sm font-medium mb-3">Hours by area</div>
        <div class="chart-container" style="height: 220px;">
          <canvas id="chart-category"></canvas>
        </div>
      </div>

      <!-- Tier breakdown -->
      <div class="p-4 rounded-xl border border-stone-100 bg-white">
        <div class="text-sm font-medium mb-3">Tier breakdown</div>

        <!-- Stacked horizontal bar -->
        <div class="flex h-8 rounded-md overflow-hidden mb-3">
          ${renderTierBar(byTier, tracked)}
        </div>

        <!-- Tier legend with hours -->
        <div class="space-y-2">
          ${[1, 2, 3]
						.map((t) => {
							const hours = byTier[t] || 0;
							const pct = tracked > 0 ? Math.round((hours / tracked) * 100) : 0;
							return `
              <div class="flex items-center justify-between text-xs">
                <div class="flex items-center gap-2">
                  <div class="w-2.5 h-2.5 rounded-sm" style="background: var(${TIERS[t].hexVar})"></div>
                  <span class="text-stone-500">${TIERS[t].label} — ${TIERS[t].description}</span>
                </div>
                <span class="font-medium">${hours} hrs (${pct}%)</span>
              </div>
            `;
						})
						.join("")}
        </div>

        ${
					avgTier1 !== null
						? `
          <div class="mt-4 text-xs text-stone-400">
            Your Tier 1 average over the past ${pastWeeks.length} weeks is ${avgTier1} hrs.
          </div>
        `
						: ""
				}
      </div>
    </div>

    <!-- ================================================================
      CHARTS ROW 2: Daily breakdown + Merchant table
      ================================================================ -->
    <div class="grid grid-cols-2 gap-4 mb-6">

      <!-- Daily breakdown (only shown for weekly view) -->
      <div class="p-4 rounded-xl border border-stone-100 bg-white">
        <div class="text-sm font-medium mb-3">
          ${currentPeriod === "daily" ? "Hourly breakdown" : "Daily breakdown"}
        </div>
        <div class="chart-container" style="height: 220px;">
          <canvas id="chart-daily"></canvas>
        </div>
      </div>

      <!-- Merchant table or billable breakdown -->
      <div class="p-4 rounded-xl border border-stone-100 bg-white">
        ${
					appState.settings.enableMerchant && Object.keys(byMerchant).length > 0
						? renderMerchantTable(byMerchant, tracked)
						: renderBillableBreakdown(entries, tracked)
				}
      </div>
    </div>

    <!-- ================================================================
      TREND CHART (past 8 weeks)
      ================================================================ -->
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
          <div class="w-4 h-0.5 rounded" style="background: var(--positive); border-top: 1px dashed var(--positive);"></div>Tier 1 hours
        </div>
        <div class="flex items-center gap-1.5 text-xs text-stone-400">
          <div class="w-4 h-0.5 rounded" style="background: var(--warning); border-top: 1px dashed var(--warning);"></div>Billable hours
        </div>
      </div>
    </div>
  `;

	/* Render Chart.js charts after DOM is ready */
	renderCategoryChart(byCategory);
	renderDailyChart(entries, range);
	renderTrendChart(history);

	/* Attach event listeners */
	attachStatsListeners();
}

/* ============================================================================
 * HELPER RENDERERS
 * ========================================================================= */

/**
 * renderTierBar
 * Generates the inline HTML for the horizontal stacked tier bar.
 */
function renderTierBar(byTier, total) {
	if (total === 0) {
		return '<div class="flex-1 bg-stone-100 flex items-center justify-center text-xs text-stone-400">No data</div>';
	}

	return [1, 2, 3]
		.map((t) => {
			const hours = byTier[t] || 0;
			const pct = Math.round((hours / total) * 100);
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
	/* Sort merchants by hours descending */
	const sorted = Object.entries(byMerchant).sort((a, b) => b[1] - a[1]);

	const topMerchants = sorted.slice(0, 8);
	const remaining = sorted.slice(8);
	const remainingHours = remaining.reduce((s, [, h]) => s + h, 0);
	const maxHours = topMerchants.length > 0 ? topMerchants[0][1] : 1;

	let html = '<div class="text-sm font-medium mb-3">Merchant time</div>';
	html += '<div class="space-y-1.5">';

	topMerchants.forEach(([name, hours]) => {
		const pct = total > 0 ? Math.round((hours / total) * 100) : 0;
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
 * Returns the expected trackable hours for the current period.
 */
function getExpectedHours() {
	switch (currentPeriod) {
		case "daily":
			return TARGETS.dailyTrackableHours;
		case "weekly":
			return TARGETS.weeklyTrackableHours;
		case "monthly": {
			/* Approximate: ~22 working days per month */
			const range = getPeriodRange();
			const days = countWeekdaysInRange(range.startDate, range.endDate);
			return days * TARGETS.dailyTrackableHours;
		}
		case "quarterly": {
			const range = getPeriodRange();
			const days = countWeekdaysInRange(range.startDate, range.endDate);
			return days * TARGETS.dailyTrackableHours;
		}
		case "fy":
		case "cy": {
			const range = getPeriodRange();
			const days = countWeekdaysInRange(range.startDate, range.endDate);
			return days * TARGETS.dailyTrackableHours;
		}
		default:
			return TARGETS.weeklyTrackableHours;
	}
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
	const data = CATEGORIES.filter((cat) => (byCategory[cat.id] || 0) > 0).sort(
		(a, b) => (byCategory[b.id] || 0) - (byCategory[a.id] || 0),
	);

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
		const data = CATEGORIES.filter((cat) => (byCategory[cat.id] || 0) > 0).sort(
			(a, b) => (byCategory[b.id] || 0) - (byCategory[a.id] || 0),
		);

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
			return entries.some((e) => e.category === cat.id);
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

	/* Reverse so oldest is on the left */
	const reversed = [...history].reverse();

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
				},
				{
					label: "Tier 1 hours",
					data: reversed.map((w) => w.byTier[1] || 0),
					borderColor: getChartColors().positive,
					borderDash: [6, 3],
					tension: 0.3,
					pointRadius: 3,
					pointBackgroundColor: getChartColors().positive,
					borderWidth: 2,
					fill: false,
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
}
