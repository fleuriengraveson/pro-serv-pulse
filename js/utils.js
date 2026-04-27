/* ============================================================================
 * utils.js — Chronos Shared Utility Functions
 * ============================================================================
 * Common helpers used across multiple modules: date formatting, time slot
 * generation, statistical calculations for outlier detection, and
 * export/import file handling.
 * ========================================================================= */

import { TIME_DEFAULTS, TARGETS, CATEGORIES } from "./config.js";

/* ============================================================================
 * DATE FORMATTING
 * ========================================================================= */

/**
 * formatDateISO
 * Converts a Date object to 'YYYY-MM-DD' string for consistent storage.
 *
 * @param {Date} date
 * @returns {string} e.g., '2026-04-22'
 */
export function formatDateISO(date) {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * formatDateDisplay
 * Formats a date for human-readable display in the UI.
 *
 * @param {Date} date
 * @returns {string} e.g., 'Wednesday, Apr 22'
 */
export function formatDateDisplay(date) {
	return date.toLocaleDateString("en-US", {
		weekday: "long",
		month: "short",
		day: "numeric",
	});
}

/**
 * formatDateShort
 * Short date format for compact UI elements like the week bar.
 *
 * @param {Date} date
 * @returns {string} e.g., 'Mon 20'
 */
export function formatDateShort(date) {
	const day = date.toLocaleDateString("en-US", { weekday: "short" });
	return `${day} ${date.getDate()}`;
}

/**
 * parseDate
 * Parses a 'YYYY-MM-DD' string back into a Date object.
 * Uses explicit year/month/day to avoid timezone issues.
 *
 * @param {string} dateStr - Date string in 'YYYY-MM-DD' format
 * @returns {Date}
 */
export function parseDate(dateStr) {
	const [y, m, d] = dateStr.split("-").map(Number);
	return new Date(y, m - 1, d);
}

/* ============================================================================
 * WEEK CALCULATIONS
 * ========================================================================= */

/**
 * getISOWeekKey
 * Returns the ISO week key for a given date (e.g., '2026-W17').
 * Uses the ISO 8601 week numbering system.
 *
 * @param {Date} date
 * @returns {string} e.g., '2026-W17'
 */
export function getISOWeekKey(date) {
	/* Create a copy to avoid mutating the original */
	const d = new Date(
		Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
	);

	/* Set to nearest Thursday (ISO weeks start on Monday, week 1 contains Jan 4) */
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));

	/* Get the year of the Thursday */
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);

	return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * getWeekDates
 * Returns an array of 5 Date objects (Monday through Friday) for the
 * week containing the given date.
 *
 * @param {Date} date - Any date within the desired week
 * @returns {Array<Date>} Array of 5 dates [Mon, Tue, Wed, Thu, Fri]
 */
export function getWeekDates(date) {
	const d = new Date(date);
	/* Find Monday: getDay() returns 0=Sun, 1=Mon, ..., 6=Sat */
	const dayOfWeek = d.getDay();
	const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
	const monday = new Date(d);
	monday.setDate(d.getDate() + mondayOffset);

	/* Generate Mon through Fri */
	const weekDates = [];
	for (let i = 0; i < 5; i++) {
		const day = new Date(monday);
		day.setDate(monday.getDate() + i);
		weekDates.push(day);
	}
	return weekDates;
}

/**
 * getWeekDateRange
 * Returns the start (Monday) and end (Friday) date strings for a given week.
 *
 * @param {Date} date - Any date within the desired week
 * @returns {Object} { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }
 */
export function getWeekDateRange(date) {
	const dates = getWeekDates(date);
	return {
		startDate: formatDateISO(dates[0]),
		endDate: formatDateISO(dates[4]),
	};
}

/* ============================================================================
 * FISCAL YEAR HELPERS
 * ========================================================================= */

/**
 * getFiscalYear
 * Determines the fiscal year for a given date.
 * Fiscal year starts April 1, so April 2026 through March 2027 is FY2026.
 *
 * @param {Date} date
 * @returns {number} The fiscal year number
 */
export function getFiscalYear(date) {
	const month = date.getMonth() + 1; // 1-indexed
	const year = date.getFullYear();
	/* If before April, we're still in the previous fiscal year */
	return month < TARGETS.fiscalYearStartMonth ? year - 1 : year;
}

/**
 * getFiscalYearRange
 * Returns the start and end dates for a given fiscal year.
 *
 * @param {number} fy - Fiscal year number (e.g., 2026)
 * @returns {Object} { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }
 */
export function getFiscalYearRange(fy) {
	return {
		startDate: `${fy}-04-01`,
		endDate: `${fy + 1}-03-31`,
	};
}

/* ============================================================================
 * TIME SLOT GENERATION
 * ========================================================================= */

/**
 * generateTimeSlots
 * Creates the array of time slot strings for the daily grid based on
 * user settings (start/end hours).
 *
 * @param {number} startHour - Start hour (default 8)
 * @param {number} endHour   - End hour (default 17)
 * @returns {Array<string>} e.g., ['08:00', '08:30', '09:00', ..., '16:30']
 */
export function generateTimeSlots(
	startHour = TIME_DEFAULTS.dayStartHour,
	endHour = TIME_DEFAULTS.dayEndHour,
) {
	const slots = [];
	for (let h = startHour; h < endHour; h++) {
		slots.push(`${String(h).padStart(2, "0")}:00`);
		slots.push(`${String(h).padStart(2, "0")}:30`);
	}
	return slots;
}

/**
 * formatTimeSlot
 * Converts a 24h time slot string to a display-friendly format.
 *
 * @param {string} slot - e.g., '09:00' or '13:30'
 * @returns {string} e.g., '9:00 AM' or '1:30 PM'
 */
export function formatTimeSlot(slot) {
	const [h, m] = slot.split(":").map(Number);
	const period = h >= 12 ? "PM" : "AM";
	const displayHour = h > 12 ? h - 12 : h === 0 ? 12 : h;
	return `${displayHour}:${String(m).padStart(2, "0")} ${period}`;
}

/* ============================================================================
 * STATISTICS AND OUTLIER DETECTION
 * ========================================================================= */

/**
 * calculateMean
 * Computes the arithmetic mean of an array of numbers.
 *
 * @param {Array<number>} values
 * @returns {number} The mean value, or 0 if empty
 */
export function calculateMean(values) {
	if (!values.length) return 0;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * calculateStdDev
 * Computes the population standard deviation of an array of numbers.
 *
 * @param {Array<number>} values
 * @returns {number} The standard deviation, or 0 if empty
 */
export function calculateStdDev(values) {
	if (values.length < 2) return 0;
	const mean = calculateMean(values);
	const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
	return Math.sqrt(calculateMean(squaredDiffs));
}

/**
 * detectOutliers
 * Compares a single value against an array of historical values.
 * Returns outlier status if the value exceeds the threshold.
 *
 * @param {number} current     - The current period's value
 * @param {Array<number>} history - Array of historical values
 * @param {number} threshold   - Number of std deviations to flag (default 1.5)
 * @returns {Object|null} { direction: 'high'|'low', deviation, mean, stdDev } or null
 */
export function detectOutlier(current, history, threshold = 1.5) {
	if (history.length < 3) return null; // Need enough data for meaningful detection

	const mean = calculateMean(history);
	const stdDev = calculateStdDev(history);

	/* Avoid flagging when there's very little variation */
	if (stdDev === 0) return null;

	const deviation = (current - mean) / stdDev;

	if (Math.abs(deviation) >= threshold) {
		return {
			direction: deviation > 0 ? "high" : "low",
			deviation: Math.round(deviation * 10) / 10,
			mean: Math.round(mean * 10) / 10,
			stdDev: Math.round(stdDev * 10) / 10,
			percentChange: mean > 0 ? Math.round(((current - mean) / mean) * 100) : 0,
		};
	}

	return null;
}

/* ============================================================================
 * ENTRY AGGREGATION HELPERS
 * ========================================================================= */

/**
 * aggregateByCategory
 * Groups time entries by category and sums the hours.
 *
 * @param {Array<Object>} entries - Array of time entry objects
 * @returns {Object} Map of category ID → total hours
 */
export function aggregateByCategory(entries) {
	const result = {};
	for (const entry of entries) {
		if (!entry.category) continue;
		const hours = TIME_DEFAULTS.blockMinutes / 60;
		result[entry.category] = (result[entry.category] || 0) + hours;
	}
	return result;
}

/**
 * aggregateByTier
 * Groups time entries by tier and sums the hours.
 * Requires the current tier mapping to resolve categories to tiers.
 *
 * @param {Array<Object>} entries - Array of time entry objects
 * @param {Object} tierMap        - Category-to-tier mapping
 * @returns {Object} Map of tier number → total hours
 */
export function aggregateByTier(entries, tierMap) {
	const result = { 1: 0, 2: 0, 3: 0 };
	for (const entry of entries) {
		if (!entry.category) continue;
		const tier = tierMap[entry.category] || 3;
		const hours = TIME_DEFAULTS.blockMinutes / 60;
		result[tier] += hours;
	}
	return result;
}

/**
 * aggregateByMerchant
 * Groups time entries by merchant and sums the hours.
 * Only includes entries that have a merchant value.
 *
 * @param {Array<Object>} entries - Array of time entry objects
 * @returns {Object} Map of merchant name → total hours
 */
export function aggregateByMerchant(entries) {
	const result = {};
	for (const entry of entries) {
		if (!entry.merchant) continue;
		const hours = TIME_DEFAULTS.blockMinutes / 60;
		result[entry.merchant] = (result[entry.merchant] || 0) + hours;
	}
	return result;
}

/**
 * countBillableHours
 * Sums the hours of all entries flagged as billable.
 *
 * @param {Array<Object>} entries - Array of time entry objects
 * @returns {number} Total billable hours
 */
export function countBillableHours(entries) {
	return (
		entries.filter((e) => e.billable).length * (TIME_DEFAULTS.blockMinutes / 60)
	);
}

/**
 * countTrackedHours
 * Sums the hours of all entries that have a category assigned
 * (i.e., are not empty/untracked blocks). Excludes lunch.
 *
 * @param {Array<Object>} entries - Array of time entry objects
 * @returns {number} Total tracked hours (excluding lunch)
 */
export function countTrackedHours(entries) {
	return (
		entries.filter((e) => e.category && e.category !== "lunch").length *
		(TIME_DEFAULTS.blockMinutes / 60)
	);
}

/**
 * countTotalHoursIncludingLunch
 * Sums ALL filled blocks including lunch. Used for the "total hours" metric.
 *
 * @param {Array<Object>} entries - Array of time entry objects
 * @returns {number} Total hours including lunch
 */
export function countTotalHours(entries) {
	return (
		entries.filter((e) => e.category).length * (TIME_DEFAULTS.blockMinutes / 60)
	);
}

/* ============================================================================
 * EXPORT / IMPORT FILE HELPERS
 * ========================================================================= */

/**
 * generateExportFilename
 * Creates a standardized filename for weekly exports.
 *
 * @param {string} name    - User's name (from settings)
 * @param {string} weekKey - ISO week key, e.g., '2026-W17'
 * @returns {string} e.g., 'fleurien_2026-W17.json'
 */
export function generateExportFilename(name, weekKey) {
	/* Sanitize name: lowercase, replace spaces with underscores, remove special chars */
	const safeName = name
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/[^a-z0-9_]/g, "");
	return `${safeName || "unnamed"}_${weekKey}.json`;
}

/**
 * downloadJSON
 * Triggers a browser download of a JSON object as a .json file.
 *
 * @param {Object} data     - The data to export
 * @param {string} filename - The download filename
 */
export function downloadJSON(data, filename) {
	const blob = new Blob([JSON.stringify(data, null, 2)], {
		type: "application/json",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

/**
 * readJSONFile
 * Reads a File object and parses its contents as JSON.
 *
 * @param {File} file - A File object from a file input or drag-and-drop
 * @returns {Promise<Object>} The parsed JSON data
 */
export function readJSONFile(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			try {
				resolve(JSON.parse(reader.result));
			} catch (err) {
				reject(new Error(`Failed to parse ${file.name}: ${err.message}`));
			}
		};
		reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
		reader.readAsText(file);
	});
}

/* ============================================================================
 * CATEGORY LOOKUP HELPERS
 * ========================================================================= */

/**
 * getCategoryById
 * Finds a category object by its ID.
 *
 * @param {string} id - Category ID
 * @returns {Object|undefined} The category object or undefined
 */
export function getCategoryById(id) {
	return CATEGORIES.find((c) => c.id === id);
}

/**
 * getCategoryLabel
 * Returns the display label for a category ID.
 *
 * @param {string} id - Category ID
 * @returns {string} The label, or the ID itself if not found
 */
export function getCategoryLabel(id) {
	const cat = getCategoryById(id);
	return cat ? cat.label : id;
}

/**
 * getCategoryHex
 * Returns the hex color for a category ID.
 *
 * @param {string} id - Category ID
 * @returns {string} The hex color, or a default gray
 */
export function getCategoryHex(id) {
	const cat = getCategoryById(id);
	return cat ? cat.hex : "var(--cat-other-border)";
}
