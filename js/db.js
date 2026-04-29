/* ============================================================================
 * db.js — Chronos Database Layer (Dexie.js / IndexedDB)
 * ============================================================================
 * Handles all persistent data storage using IndexedDB via the Dexie.js
 * wrapper library. Provides clean async methods for CRUD operations on
 * time entries, user settings, tier mappings, and imported team data.
 *
 * Dexie is loaded globally from CDN in index.html, so we access it
 * via the global `Dexie` variable.
 * ========================================================================= */

import { DEFAULT_USER_SETTINGS, DEFAULT_TIER_MAP } from "./config.js";

/* ----------------------------------------------------------------------------
 * DATABASE INITIALIZATION
 * --------------------------------------------------------------------------
 * Creates (or opens) the Chronos IndexedDB database with the required
 * object stores (tables) and their indexed fields.
 *
 * Dexie uses a versioning system — if you need to change the schema later,
 * increment the version number and add a new .stores() definition.
 * Only indexed fields need to be declared; any other fields can be stored
 * freely on each record.
 * ------------------------------------------------------------------------- */
const db = new Dexie("ChronosDB");

db.version(1).stores({
	/* Time entries: one record per 30-minute block
	 * Compound index [date+timeSlot] ensures uniqueness per block
	 * Individual indexes on date and category for efficient querying */
	entries: "++id, [date+timeSlot], date, category",

	/* User settings: single record (key = 'user')
	 * Stores name, role, preferences, etc. */
	settings: "key",

	/* Tier mappings: single record (key = 'tiers')
	 * Stores the category-to-tier mapping object */
	tierMap: "key",

	/* Weekly qualitative notes: one record per week
	 * Keyed by ISO week string like '2026-W17' */
	weeklyNotes: "weekKey",

	/* Imported team data (manager only): one record per person per week
	 * Indexed by name and week for efficient dashboard queries */
	teamData: "++id, [name+weekKey], name, weekKey",
});

/* ============================================================================
 * SETTINGS OPERATIONS
 * ========================================================================= */

/**
 * getUserSettings
 * Retrieves the current user's settings from IndexedDB.
 * Returns default settings if none have been saved yet.
 *
 * @returns {Promise<Object>} The user settings object
 */
export async function getUserSettings() {
	const record = await db.settings.get("user");
	return record ? record.value : { ...DEFAULT_USER_SETTINGS };
}

/**
 * saveUserSettings
 * Persists the user settings object to IndexedDB.
 * Uses put() which creates or updates the record.
 *
 * @param {Object} settings - The complete settings object to save
 */
export async function saveUserSettings(settings) {
	await db.settings.put({ key: "user", value: settings });
}

/* ============================================================================
 * TIER MAP OPERATIONS
 * ========================================================================= */

/**
 * getTierMap
 * Retrieves the current category-to-tier mapping.
 * Returns the default mapping if none has been customized.
 *
 * @returns {Promise<Object>} Map of category IDs to tier numbers (1, 2, or 3)
 */
export async function getTierMap() {
	const record = await db.tierMap.get("tiers");
	return record ? record.value : { ...DEFAULT_TIER_MAP };
}

/**
 * saveTierMap
 * Persists the category-to-tier mapping. Only managers should call this.
 *
 * @param {Object} map - Map of category IDs to tier numbers
 */
export async function saveTierMap(map) {
	await db.tierMap.put({ key: "tiers", value: map });
}

/* ============================================================================
 * TIME ENTRY OPERATIONS
 * ========================================================================= */

/**
 * saveEntry
 * Creates or updates a single time entry for a specific date and time slot.
 * If an entry already exists for that date+timeSlot, it gets replaced.
 *
 * @param {Object} entry - The time entry object containing:
 *   - date {string}       e.g., '2026-04-22'
 *   - timeSlot {string}   e.g., '09:00'
 *   - category {string}   Category ID from CATEGORIES
 *   - subCategory {string} Free text sub-category
 *   - billable {boolean}  Whether this block is billable
 *   - merchant {string}   Optional merchant name
 *   - urgent {boolean}    Urgent flag
 *   - ticketLink {string} Optional ticket URL/number
 *   - formerPOS {string}  Optional former POS value
 *   - notes {string}      Optional notes
 */
export async function saveEntry(entry) {
	/* Check if an entry already exists for this date+timeSlot */
	const existing = await db.entries
		.where("[date+timeSlot]")
		.equals([entry.date, entry.timeSlot])
		.first();

	if (existing) {
		/* Update the existing record, preserving its ID */
		await db.entries.update(existing.id, entry);
	} else {
		/* Create a new record */
		await db.entries.add(entry);
	}
}

/**
 * saveMultipleEntries
 * Batch save multiple time entries at once. Useful for drag-to-fill
 * and copy-previous-day operations. Runs in a transaction for atomicity.
 *
 * @param {Array<Object>} entries - Array of time entry objects
 */
export async function saveMultipleEntries(entries) {
	await db.transaction("rw", db.entries, async () => {
		for (const entry of entries) {
			await saveEntry(entry);
		}
	});
}

/**
 * getEntriesForDate
 * Retrieves all time entries for a specific date, sorted by time slot.
 *
 * @param {string} date - Date string in 'YYYY-MM-DD' format
 * @returns {Promise<Array<Object>>} Array of time entry objects
 */
export async function getEntriesForDate(date) {
	return await db.entries.where("date").equals(date).sortBy("timeSlot");
}

/**
 * getEntriesForDateRange
 * Retrieves all time entries within a date range (inclusive).
 * Used for weekly, monthly, and other period-based queries.
 *
 * @param {string} startDate - Start date in 'YYYY-MM-DD' format
 * @param {string} endDate   - End date in 'YYYY-MM-DD' format
 * @returns {Promise<Array<Object>>} Array of time entry objects
 */
export async function getEntriesForDateRange(startDate, endDate) {
	return await db.entries
		.where("date")
		.between(startDate, endDate, true, true) // inclusive on both ends
		.sortBy("timeSlot");
}

/**
 * deleteEntry
 * Removes a single time entry by its date and time slot.
 *
 * @param {string} date     - Date string in 'YYYY-MM-DD' format
 * @param {string} timeSlot - Time slot string, e.g., '09:00'
 */
export async function deleteEntry(date, timeSlot) {
	await db.entries.where("[date+timeSlot]").equals([date, timeSlot]).delete();
}

/**
 * getAllEntries
 * Retrieves every time entry in the database. Used for full export
 * and backup operations.
 *
 * @returns {Promise<Array<Object>>} All stored time entry objects
 */
export async function getAllEntries() {
	return await db.entries.toArray();
}

/**
 * clearAllEntries
 * Deletes all time entries. Used when restoring from a backup file.
 * Should be called inside a transaction with the subsequent import.
 */
export async function clearAllEntries() {
	await db.entries.clear();
}

/**
 * getFirstTrackedDate
 * Finds the date of the earliest time entry in the database.
 * Returns null if no entries exist yet.
 *
 * @returns {Promise<string|null>} Earliest date in 'YYYY-MM-DD' format, or null
 */
export async function getFirstTrackedDate() {
	const earliest = await db.entries.orderBy("date").first();
	return earliest ? earliest.date : null;
}

/**
 * getUniqueFieldValues
 * Returns all unique non-empty values for a given field across all entries.
 * Used for autocomplete suggestions on merchant, sub-category, and former POS.
 *
 * @param {string} field - The entry field name (e.g., 'subCategory', 'merchant', 'formerPOS')
 * @returns {Promise<Array<string>>} Sorted array of unique values
 */
export async function getUniqueFieldValues(field) {
	const entries = await db.entries.toArray();
	const values = new Set();
	entries.forEach((e) => {
		if (e[field] && e[field].trim()) {
			values.add(e[field].trim());
		}
	});
	return [...values].sort((a, b) =>
		a.toLowerCase().localeCompare(b.toLowerCase()),
	);
}

/**
 * getLastEntryForMerchant
 * Finds the most recent time entry for a given merchant name.
 * Returns the entry's formerPOS and ticketLink for auto-fill.
 *
 * @param {string} merchant - The merchant name to look up (case-insensitive)
 * @returns {Promise<Object|null>} { formerPOS, ticketLink } or null if not found
 */
export async function getLastEntryForMerchant(merchant) {
	if (!merchant || !merchant.trim()) return null;

	const lowerMerchant = merchant.trim().toLowerCase();

	/* Get all entries, sorted by date descending then timeSlot descending */
	const allEntries = await db.entries.orderBy("date").reverse().toArray();

	/* Find the first (most recent) entry matching this merchant */
	const match = allEntries.find(
		(e) => e.merchant && e.merchant.trim().toLowerCase() === lowerMerchant,
	);

	if (!match) return null;

	return {
		formerPOS: match.formerPOS || "",
		ticketLink: match.ticketLink || "",
		subCategory: match.subCategory || "",
	};
}

/* ============================================================================
 * WEEKLY NOTES OPERATIONS
 * ========================================================================= */

/**
 * getWeeklyNotes
 * Retrieves the qualitative notes for a specific week.
 *
 * @param {string} weekKey - ISO week key, e.g., '2026-W17'
 * @returns {Promise<Object|null>} Notes object or null if none exist
 */
export async function getWeeklyNotes(weekKey) {
	return await db.weeklyNotes.get(weekKey);
}

/**
 * saveWeeklyNotes
 * Persists qualitative notes for a specific week.
 *
 * @param {string} weekKey - ISO week key, e.g., '2026-W17'
 * @param {Object} notes   - Object containing:
 *   - wins {string}
 *   - losses {string}
 *   - issues {string}
 *   - customerMeetings {string}
 */
export async function saveWeeklyNotes(weekKey, notes) {
	await db.weeklyNotes.put({ weekKey, ...notes });
}

/* ============================================================================
 * TEAM DATA OPERATIONS (MANAGER ONLY)
 * ========================================================================= */

/**
 * importTeamMemberData
 * Imports a single team member's weekly export into the manager's database.
 * Checks for duplicates before importing.
 *
 * @param {string} name     - Team member's name
 * @param {string} weekKey  - ISO week key, e.g., '2026-W17'
 * @param {Object} data     - The full export data object (entries, notes, settings)
 * @returns {Promise<boolean>} True if imported, false if duplicate detected
 */
export async function importTeamMemberData(name, weekKey, data) {
	/* Check for existing import from this person for this week */
	const existing = await db.teamData
		.where("[name+weekKey]")
		.equals([name, weekKey])
		.first();

	if (existing) {
		/* Duplicate detected — update the existing record instead */
		await db.teamData.update(existing.id, { name, weekKey, data });
		return false;
	}

	/* New import — add to the database */
	await db.teamData.add({ name, weekKey, data });
	return true;
}

/**
 * getTeamDataForWeek
 * Retrieves all imported team member data for a specific week.
 *
 * @param {string} weekKey - ISO week key, e.g., '2026-W17'
 * @returns {Promise<Array<Object>>} Array of team data records
 */
export async function getTeamDataForWeek(weekKey) {
	return await db.teamData.where("weekKey").equals(weekKey).toArray();
}

/**
 * getTeamDataForRange
 * Retrieves all imported team data for weeks within a date range.
 *
 * @param {string} startWeek - Start ISO week key, e.g., '2026-W10'
 * @param {string} endWeek   - End ISO week key, e.g., '2026-W17'
 * @returns {Promise<Array<Object>>} Array of team data records
 */
export async function getTeamDataForRange(startWeek, endWeek) {
	return await db.teamData
		.where("weekKey")
		.between(startWeek, endWeek, true, true)
		.toArray();
}

/**
 * getAllTeamData
 * Retrieves all imported team data. Used for full backup.
 *
 * @returns {Promise<Array<Object>>} All team data records
 */
export async function getAllTeamData() {
	return await db.teamData.toArray();
}

/**
 * getTeamMemberNames
 * Retrieves a unique list of all team member names that have been imported.
 *
 * @returns {Promise<Array<string>>} Array of unique names
 */
export async function getTeamMemberNames() {
	const records = await db.teamData.orderBy("name").uniqueKeys();
	return records;
}

/**
 * getTeamDataForPeriod
 * Retrieves all imported team data that overlaps with a date range.
 * Matches week keys that fall within the range.
 *
 * @param {string} startDate - Start date in 'YYYY-MM-DD' format
 * @param {string} endDate   - End date in 'YYYY-MM-DD' format
 * @returns {Promise<Array<Object>>} Array of team data records
 */
export async function getTeamDataForPeriod(startDate, endDate) {
	const allData = await db.teamData.toArray();
	return allData.filter((record) => {
		/* Check if this record's week overlaps with the requested range */
		const weekStart = record.data?.startDate;
		const weekEnd = record.data?.endDate;
		if (!weekStart || !weekEnd) return false;
		return weekEnd >= startDate && weekStart <= endDate;
	});
}

/**
 * getTeamMemberList
 * Returns a list of unique team member names with their most recent import date.
 *
 * @returns {Promise<Array<Object>>} Array of { name, lastImport, weekCount }
 */
export async function getTeamMemberList() {
	const allData = await db.teamData.toArray();
	const members = {};

	allData.forEach((record) => {
		const name = record.name;
		if (!members[name]) {
			members[name] = { name, lastImport: record.weekKey, weekCount: 0 };
		}
		members[name].weekCount++;
		if (record.weekKey > members[name].lastImport) {
			members[name].lastImport = record.weekKey;
		}
	});

	return Object.values(members).sort((a, b) =>
		a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
	);
}

/**
 * getTeamMemberData
 * Retrieves all imported data for a specific team member within a date range.
 *
 * @param {string} name      - Team member's name
 * @param {string} startDate - Start date in 'YYYY-MM-DD' format
 * @param {string} endDate   - End date in 'YYYY-MM-DD' format
 * @returns {Promise<Array<Object>>} Array of time entry objects
 */
export async function getTeamMemberData(name, startDate, endDate) {
	const records = await db.teamData.where("name").equals(name).toArray();

	/* Collect all entries from matching weeks */
	const entries = [];
	records.forEach((record) => {
		const weekStart = record.data?.startDate;
		const weekEnd = record.data?.endDate;
		if (!weekStart || !weekEnd) return;
		if (weekEnd < startDate || weekStart > endDate) return;

		(record.data.entries || []).forEach((e) => {
			/* Only include entries within the requested date range */
			if (e.date >= startDate && e.date <= endDate) {
				entries.push(e);
			}
		});
	});

	return entries;
}

/**
 * getTeamMemberNotes
 * Retrieves qualitative notes for a specific team member for a given week.
 *
 * @param {string} name    - Team member's name
 * @param {string} weekKey - ISO week key
 * @returns {Promise<Object|null>} Notes object or null
 */
export async function getTeamMemberNotes(name, weekKey) {
	const record = await db.teamData
		.where("[name+weekKey]")
		.equals([name, weekKey])
		.first();

	return record?.data?.weeklyNotes || null;
}

/**
 * getAllTeamEntriesForPeriod
 * Retrieves all entries from all team members for a date range.
 * Returns entries with the member name attached to each entry.
 *
 * @param {string} startDate - Start date
 * @param {string} endDate   - End date
 * @returns {Promise<Array<Object>>} Entries with .memberName attached
 */
export async function getAllTeamEntriesForPeriod(startDate, endDate) {
	const records = await getTeamDataForPeriod(startDate, endDate);
	const entries = [];

	records.forEach((record) => {
		(record.data.entries || []).forEach((e) => {
			if (e.date >= startDate && e.date <= endDate) {
				entries.push({ ...e, memberName: record.name });
			}
		});
	});

	return entries;
}

/* ============================================================================
 * BULK IMPORT / RESTORE
 * ========================================================================= */

/**
 * restoreFromBackup
 * Replaces all local data with data from a backup file.
 * Runs in a transaction to ensure atomicity — either everything
 * restores successfully or nothing changes.
 *
 * @param {Object} backupData - The full backup object containing:
 *   - entries {Array}       Time entry records
 *   - settings {Object}     User settings
 *   - tierMap {Object}      Tier mappings
 *   - weeklyNotes {Array}   Weekly notes records
 *   - teamData {Array}      Team data records (manager only)
 */
export async function restoreFromBackup(backupData) {
	await db.transaction(
		"rw",
		[db.entries, db.settings, db.tierMap, db.weeklyNotes, db.teamData],
		async () => {
			/* Clear all existing data */
			await db.entries.clear();
			await db.settings.clear();
			await db.tierMap.clear();
			await db.weeklyNotes.clear();
			await db.teamData.clear();

			/* Restore each table */
			if (backupData.entries?.length) {
				await db.entries.bulkAdd(backupData.entries);
			}
			if (backupData.settings) {
				await db.settings.put({ key: "user", value: backupData.settings });
			}
			if (backupData.tierMap) {
				await db.tierMap.put({ key: "tiers", value: backupData.tierMap });
			}
			if (backupData.weeklyNotes?.length) {
				await db.weeklyNotes.bulkAdd(backupData.weeklyNotes);
			}
			if (backupData.teamData?.length) {
				await db.teamData.bulkAdd(backupData.teamData);
			}
		},
	);
}

/**
 * exportAllData
 * Exports the entire database contents as a single object.
 * Used for full backups and migration to a hosted version later.
 *
 * @returns {Promise<Object>} Complete database export
 */
export async function exportAllData() {
	const settings = await getUserSettings();
	const tierMap = await getTierMap();
	const entries = await getAllEntries();
	const weeklyNotes = await db.weeklyNotes.toArray();
	const teamData = await getAllTeamData();

	return {
		exportDate: new Date().toISOString(),
		appVersion: "1.0.0",
		settings,
		tierMap,
		entries,
		weeklyNotes,
		teamData,
	};
}

/**
 * migrateZendeskToAdmin
 * One-time migration that converts any entries with category
 * 'zendesk_admin' to 'admin'. Called on app startup.
 */
export async function migrateZendeskToAdmin() {
	const zendeskEntries = await db.entries
		.where("category")
		.equals("zendesk_admin")
		.toArray();

	if (zendeskEntries.length > 0) {
		await db.transaction("rw", db.entries, async () => {
			for (const entry of zendeskEntries) {
				await db.entries.update(entry.id, { category: "admin" });
			}
		});
		console.log(
			`Migrated ${zendeskEntries.length} zendesk_admin entries to admin`,
		);
	}
}

/* Export the raw db instance for advanced operations if needed */
export { db };
