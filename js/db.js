/* ============================================================================
 * db.js — Pulse Database Layer (Dexie.js / IndexedDB)
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
 * Creates (or opens) the Pulse IndexedDB database with the required
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
db.version(2).stores({
	ticketStats: "date",
});

/* Version 3: Per-day metadata (queue duty tracking)
 * Keyed by date string 'YYYY-MM-DD'. Stores daily flags
 * like onQueue that apply to the whole day, not individual time slots. */
db.version(3).stores({
	dayMeta: "date",
});

/* Version 4: Enforce true uniqueness on [date+timeSlot] for entries.
 * The old index allowed duplicate rows for the same block, letting
 * racy saves double-count hours. Before Dexie applies the new unique
 * index, we scan for any existing duplicate [date+timeSlot] groups
 * and delete all but the most recently-created row in each group —
 * otherwise the upgrade will fail on existing data. */
db.version(4)
	.stores({
		entries: "++id, &[date+timeSlot], date, category",
		teamData: "++id, [name+weekKey], name, weekKey",
	})
	.upgrade(async (tx) => {
		const all = await tx.table("entries").toArray();

		/* Group rows by their [date+timeSlot] key */
		const groups = new Map();
		for (const row of all) {
			const key = `${row.date}|${row.timeSlot}`;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(row);
		}

		/* For any group with more than one row, keep the row with the
		 * highest id (most recently written) and delete the rest. */
		const idsToDelete = [];
		for (const rows of groups.values()) {
			if (rows.length <= 1) continue;
			rows.sort((a, b) => b.id - a.id);
			for (let i = 1; i < rows.length; i++) idsToDelete.push(rows[i].id);
		}

		if (idsToDelete.length > 0) {
			await tx.table("entries").bulkDelete(idsToDelete);
		}
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
	/* Wrap the lookup + write in a transaction so concurrent calls to
	 * saveEntry can't interleave and both decide "no existing row" at
	 * once. IndexedDB serializes readwrite transactions against the
	 * same store, so this closes the race that used to allow duplicate
	 * [date+timeSlot] rows. The unique index on entries is a hard
	 * backstop even if some other code path bypasses this function. */
	await db.transaction("rw", db.entries, async () => {
		const existing = await db.entries
			.where("[date+timeSlot]")
			.equals([entry.date, entry.timeSlot])
			.first();

		if (existing) {
			/* Update in place, keeping the same id. Set id directly on the
			 * object rather than relying on put(obj, key) — Dexie doesn't
			 * reliably inject an explicit key into an object with no id
			 * property on tables with an auto-incrementing primary key,
			 * which was causing it to attempt an insert instead of an
			 * update and collide with the unique [date+timeSlot] index. */
			await db.entries.put({ ...entry, id: existing.id });
		} else {
			await db.entries.add(entry);
		}
	});
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
 * deleteMultipleEntries
 * Batch delete multiple time entries at once. Runs in a single
 * transaction so a clear/delete operation can't be left half-done
 * (e.g. if the tab closes mid-loop).
 *
 * @param {Array<{date: string, timeSlot: string}>} keys - date+timeSlot pairs to delete
 */
export async function deleteMultipleEntries(keys) {
	await db.transaction("rw", db.entries, async () => {
		for (const { date, timeSlot } of keys) {
			await deleteEntry(date, timeSlot);
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
	return await db.transaction("rw", db.teamData, async () => {
		const existing = await db.teamData
			.where("[name+weekKey]")
			.equals([name, weekKey])
			.first();

		if (existing) {
			await db.teamData.put({ id: existing.id, name, weekKey, data });
			return false;
		}

		await db.teamData.add({ name, weekKey, data });
		return true;
	});
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
 * getFirstTrackedDateForMember
 * Finds a team member's TRUE first-tracked ("join") date — the earliest
 * entry date found across ALL of their imported weeks, not just the weeks
 * that happen to fall inside whatever period is currently being viewed.
 *
 * This mirrors getFirstTrackedDate() above, which does the same thing for
 * the local user's own entries table. Without this, a manager viewing a
 * single week would see a member's "first date" as the first day THAT
 * MEMBER TRACKED SOMETHING IN THAT WEEK — which wrongly clamps their
 * expected hours to whichever day they happened to start tracking, and
 * hides any no-entry days before that within the same period.
 *
 * @param {string} name - Team member's name
 * @returns {Promise<string|null>} Earliest date across all their imported
 *   weeks in 'YYYY-MM-DD' format, or null if they have no imported data
 *   (or no entries with a date on any of it).
 */
export async function getFirstTrackedDateForMember(name) {
	const records = await db.teamData.where("name").equals(name).toArray();

	let earliest = null;
	records.forEach((record) => {
		(record.data?.entries || []).forEach((e) => {
			if (e.date && (earliest === null || e.date < earliest)) {
				earliest = e.date;
			}
		});
	});

	return earliest;
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

/**
 * getAllTeamNotesForWeek
 * Retrieves qualitative notes for all team members for a given week.
 *
 * @param {string} weekKey - ISO week key
 * @returns {Promise<Array<Object>>} Array of { name, notes }
 */
export async function getAllTeamNotesForWeek(weekKey) {
	const records = await db.teamData.where("weekKey").equals(weekKey).toArray();

	return records
		.filter((r) => r.data?.weeklyNotes)
		.map((r) => ({
			name: r.name,
			notes: r.data.weeklyNotes,
		}));
}

/**
 * getTeamMemberTicketStats
 * Retrieves ticket stats from an imported team member's data for a date range.
 *
 * @param {string} name - Team member name
 * @param {string} startDate - 'YYYY-MM-DD'
 * @param {string} endDate - 'YYYY-MM-DD'
 * @returns {Promise<Array<Object>>} Array of daily ticket stat records
 */
export async function getTeamMemberTicketStats(name, startDate, endDate) {
	const records = await db.teamData.where("name").equals(name).toArray();

	const stats = [];
	records.forEach((r) => {
		if (!r.data?.ticketStats) return;
		r.data.ticketStats.forEach((s) => {
			if (s.date >= startDate && s.date <= endDate) {
				stats.push({ ...s, memberName: name });
			}
		});
	});

	return stats;
}

/**
 * getAllTeamTicketStats
 * Retrieves ticket stats for all team members in a date range.
 *
 * @param {string} startDate - 'YYYY-MM-DD'
 * @param {string} endDate - 'YYYY-MM-DD'
 * @returns {Promise<Array<Object>>}
 */
export async function getAllTeamTicketStats(startDate, endDate) {
	const records = await db.teamData.toArray();
	const stats = [];

	records.forEach((r) => {
		if (!r.data?.ticketStats) return;
		r.data.ticketStats.forEach((s) => {
			if (s.date >= startDate && s.date <= endDate) {
				stats.push({ ...s, memberName: r.name });
			}
		});
	});

	return stats;
}

/**
 * getTeamMemberDayMeta
 * Retrieves day metadata from an imported team member's data for a date range.
 * Reads from the teamData store's embedded data.dayMeta array.
 *
 * @param {string} name      - Team member name
 * @param {string} startDate - 'YYYY-MM-DD'
 * @param {string} endDate   - 'YYYY-MM-DD'
 * @returns {Promise<Array<Object>>} Array of dayMeta records with memberName
 */
export async function getTeamMemberDayMeta(name, startDate, endDate) {
	const records = await db.teamData.where("name").equals(name).toArray();

	const metas = [];
	records.forEach((r) => {
		if (!r.data?.dayMeta) return;
		r.data.dayMeta.forEach((m) => {
			if (m.date >= startDate && m.date <= endDate) {
				metas.push({ ...m, memberName: name });
			}
		});
	});

	return metas;
}

/**
 * getAllTeamDayMeta
 * Retrieves day metadata for all team members in a date range.
 * Used by the manager stats page to show queue day counts per person.
 *
 * @param {string} startDate - 'YYYY-MM-DD'
 * @param {string} endDate   - 'YYYY-MM-DD'
 * @returns {Promise<Array<Object>>} Array of dayMeta records with memberName
 */
export async function getAllTeamDayMeta(startDate, endDate) {
	const records = await db.teamData.toArray();

	const metas = [];
	records.forEach((r) => {
		if (!r.data?.dayMeta) return;
		r.data.dayMeta.forEach((m) => {
			if (m.date >= startDate && m.date <= endDate) {
				metas.push({ ...m, memberName: r.name });
			}
		});
	});

	return metas;
}

/* ============================================================================
 * BULK IMPORT / RESTORE
 * ========================================================================= */

/**
 * isFullBackupFile
 * Detects whether parsed JSON came from the "Full backup" export
 * (exportAllData) rather than a weekly or sync-folder personal export.
 * exportAllData() always includes every one of these keys, even as
 * empty arrays. Weekly/personal exports never include `teamData` and
 * use different shapes (`weekKey`, `allEntries`).
 *
 * @param {Object} data - Parsed JSON from an uploaded backup file
 * @returns {boolean}
 */
export function isFullBackupFile(data) {
	if (!data || typeof data !== "object") return false;
	const requiredKeys = [
		"entries",
		"settings",
		"tierMap",
		"weeklyNotes",
		"teamData",
		"ticketStats",
		"dayMeta",
	];
	const hasAllKeys = requiredKeys.every((key) => key in data);
	const looksLikeSyncFormat = "weekKey" in data || "allEntries" in data;
	return hasAllKeys && !looksLikeSyncFormat;
}

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
	/* Refuse partial/weekly files here — this function clears every
	 * table first, so restoring anything less than a full export would
	 * silently delete teamData, ticketStats, and dayMeta. Use
	 * restoreFromPersonalBackup (via "Restore from sync folder") for
	 * weekly or personal-only files instead. */
	if (!isFullBackupFile(backupData)) {
		throw new Error(
			"This file isn't a full backup — it's missing teamData/ticketStats/dayMeta or in the wrong format. Restoring it here would delete data not present in the file. Use 'Restore from sync folder' for weekly exports instead.",
		);
	}

	await db.transaction(
		"rw",
		[
			db.entries,
			db.settings,
			db.tierMap,
			db.weeklyNotes,
			db.teamData,
			db.ticketStats,
			db.dayMeta,
		],
		async () => {
			/* Clear all existing data */
			await db.entries.clear();
			await db.settings.clear();
			await db.tierMap.clear();
			await db.weeklyNotes.clear();
			await db.teamData.clear();
			await db.ticketStats.clear();
			await db.dayMeta.clear();

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
			if (backupData.ticketStats?.length) {
				await db.ticketStats.bulkAdd(backupData.ticketStats);
			}
			if (backupData.dayMeta?.length) {
				await db.dayMeta.bulkAdd(backupData.dayMeta);
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
	const ticketStats = await db.ticketStats.toArray();
	const dayMeta = await db.dayMeta.toArray();

	return {
		exportDate: new Date().toISOString(),
		appVersion: "1.0.0",
		settings,
		tierMap,
		entries,
		weeklyNotes,
		teamData,
		ticketStats,
		dayMeta,
	};
}

/**
 * getTicketStats
 * Returns the ticket stats for a given date.
 *
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {Promise<Object|null>} { date, queueSize, newTickets, closedTickets }
 */
export async function getTicketStats(date) {
	return (await db.ticketStats.get(date)) || null;
}

/**
 * saveTicketStats
 * Saves or updates ticket stats for a given date.
 *
 * @param {string} date - 'YYYY-MM-DD'
 * @param {Object} stats - { queueSize, newTickets, closedTickets }
 */
export async function saveTicketStats(date, stats) {
	await db.ticketStats.put({
		date,
		queueSize: stats.queueSize,
		newTickets: stats.newTickets,
		closedTickets: stats.closedTickets,
	});
}

/**
 * getTicketStatsForRange
 * Returns all ticket stats records within a date range.
 *
 * @param {string} startDate - 'YYYY-MM-DD'
 * @param {string} endDate - 'YYYY-MM-DD'
 * @returns {Promise<Array<Object>>}
 */
export async function getTicketStatsForRange(startDate, endDate) {
	return await db.ticketStats
		.where("date")
		.between(startDate, endDate, true, true)
		.toArray();
}

/**
 * getMostRecentTicketStats
 * Returns the most recent ticket stats record (for carrying forward queue size).
 *
 * @returns {Promise<Object|null>}
 */
export async function getMostRecentTicketStats() {
	const all = await db.ticketStats.orderBy("date").reverse().limit(1).toArray();
	return all.length > 0 ? all[0] : null;
}

/* ============================================================================
 * DAY META OPERATIONS (QUEUE DUTY TRACKING)
 * --------------------------------------------------------------------------
 * Stores per-day metadata like queue duty status. Each record represents
 * one calendar day and holds flags that apply to the whole day rather
 * than individual time slots.
 * ========================================================================= */

/**
 * getDayMeta
 * Retrieves the metadata record for a single date.
 *
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {Promise<Object|null>} { date, onQueue } or null if no record
 */
export async function getDayMeta(date) {
	return (await db.dayMeta.get(date)) || null;
}

/**
 * saveDayMeta
 * Creates or updates the metadata record for a single date.
 * Uses put() so it upserts — creates if missing, replaces if exists.
 *
 * @param {string} date - 'YYYY-MM-DD'
 * @param {Object} meta - Metadata fields, e.g. { onQueue: true }
 */
export async function saveDayMeta(date, meta) {
	await db.dayMeta.put({ date, ...meta });
}

/**
 * getDayMetaForRange
 * Retrieves all day metadata records within a date range (inclusive).
 * Used to load queue status for a full week in the tracker, or for
 * counting queue days across a stats period.
 *
 * @param {string} startDate - 'YYYY-MM-DD'
 * @param {string} endDate   - 'YYYY-MM-DD'
 * @returns {Promise<Array<Object>>} Array of dayMeta records
 */
export async function getDayMetaForRange(startDate, endDate) {
	return await db.dayMeta
		.where("date")
		.between(startDate, endDate, true, true)
		.toArray();
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

/**
 * migrateAdminSplit
 * Converts old 'admin' entries to 'admin_internal' after the category split.
 */
export async function migrateAdminSplit() {
	const migrated = localStorage.getItem("chronos-admin-split-migrated");
	if (migrated) return;

	const allEntries = await db.entries.toArray();
	const adminEntries = allEntries.filter((e) => e.category === "admin");

	console.log(
		"Admin migration: found",
		adminEntries.length,
		"entries to update",
	);

	for (const entry of adminEntries) {
		entry.category = "admin_internal";
		await db.entries.put(entry);
	}

	if (adminEntries.length > 0) {
		console.log(
			"Admin migration: updated",
			adminEntries.length,
			"entries to admin_internal",
		);
	}

	localStorage.setItem("chronos-admin-split-migrated", "true");
}

/**
 * hasAnyData
 * Quick check if the user has any tracked entries.
 * Used for empty database detection on startup.
 *
 * @returns {Promise<boolean>}
 */
export async function hasAnyData() {
	const count = await db.entries.count();
	return count > 0;
}

/**
 * getEntryCount
 * Returns the total number of entries in the database.
 * Used for overwrite protection in backup.
 *
 * @returns {Promise<number>}
 */
export async function getEntryCount() {
	return await db.entries.count();
}

/**
 * restoreFromPersonalBackup
 * Imports data from a personal backup file into the user's own tables.
 * This is NOT the team import — it writes to entries, weeklyNotes,
 * ticketStats, and settings directly.
 *
 * @param {Object} backupData - The parsed backup JSON
 * @returns {Promise<{ entries: number, notes: number, tickets: number }>}
 */
export async function restoreFromPersonalBackup(backupData) {
	let entryCount = 0;
	let notesCount = 0;
	let ticketCount = 0;

	/* Build a lookup of existing local [date+timeSlot] pairs, so we skip
	 * any backup entry that would duplicate something already logged
	 * locally since the wipe (local wins — it's newer). This Set is
	 * updated as we insert below, so entries that collide with EACH
	 * OTHER within the same backup (e.g. overlapping weekly files) are
	 * also caught, not just collisions with pre-existing local data. */
	const existingEntries = await db.entries.toArray();
	const existingKeys = new Set(
		existingEntries.map((e) => `${e.date}|${e.timeSlot}`),
	);

	/* Wrap the whole restore in a transaction so a failure partway
	 * through (e.g. an unexpected ConstraintError) rolls back cleanly
	 * instead of leaving a half-merged database. Matches the atomicity
	 * restoreFromBackup already has. */
	await db.transaction(
		"rw",
		[
			db.entries,
			db.settings,
			db.tierMap,
			db.weeklyNotes,
			db.ticketStats,
			db.dayMeta,
		],
		async () => {
			/* Restore settings if present */
			if (backupData.settings) {
				const restoredSettings =
					backupData.settings.value || backupData.settings;
				await db.settings.put({
					key: "user",
					value: {
						...DEFAULT_USER_SETTINGS,
						...restoredSettings,
					},
				});
			}

			/* Restore tier map if present */
			if (backupData.tierMap) {
				const restoredTierMap = backupData.tierMap.value || backupData.tierMap;
				await db.tierMap.put({
					key: "tiers",
					value: {
						...DEFAULT_TIER_MAP,
						...restoredTierMap,
					},
				});
			}

			/* Restore settings/tier map from weekly backup bundles as well */
			if (backupData.weeks?.length && !backupData.settings) {
				for (const week of backupData.weeks) {
					if (week.settings) {
						const restoredSettings = week.settings.value || week.settings;
						await db.settings.put({
							key: "user",
							value: {
								...DEFAULT_USER_SETTINGS,
								...restoredSettings,
							},
						});
						break;
					}
				}
			}

			if (backupData.weeks?.length && !backupData.tierMap) {
				for (const week of backupData.weeks) {
					if (week.tierMap) {
						const restoredTierMap = week.tierMap.value || week.tierMap;
						await db.tierMap.put({
							key: "tiers",
							value: {
								...DEFAULT_TIER_MAP,
								...restoredTierMap,
							},
						});
						break;
					}
				}
			}

			/* Restore entries — from weekly files or full backup format */
			if (backupData.weeks) {
				/* Multi-week format */
				for (const week of backupData.weeks) {
					if (week.entries) {
						for (const entry of week.entries) {
							const key = `${entry.date}|${entry.timeSlot}`;
							if (existingKeys.has(key))
								continue; /* local entry already covers this slot */
							/* Never trust an id carried over from another device —
							 * a stale id can coincidentally match an unrelated
							 * local row and silently overwrite it. Let Dexie
							 * assign a fresh one; the unique [date+timeSlot]
							 * index still guards against real duplicates. */
							const { id, ...safeEntry } = entry;
							await db.entries.put(safeEntry);
							existingKeys.add(key);
							entryCount++;
						}
					}

					if (week.weeklyNotes) {
						await db.weeklyNotes.put({
							weekKey: week.weekKey,
							...week.weeklyNotes,
						});
						notesCount++;
					}

					if (week.ticketStats) {
						for (const stat of week.ticketStats) {
							await db.ticketStats.put(stat);
							ticketCount++;
						}
					}

					if (week.dayMeta) {
						for (const meta of week.dayMeta) {
							await db.dayMeta.put(meta);
						}
					}
				}
			} else if (backupData.allEntries) {
				/* Full backup format */
				for (const entry of backupData.allEntries) {
					const key = `${entry.date}|${entry.timeSlot}`;
					if (existingKeys.has(key)) continue;
					/* Same id-stripping guard as above — allEntries comes
					 * straight from the source device's db.entries.toArray()
					 * and still carries that device's ids. */
					const { id, ...safeEntry } = entry;
					await db.entries.put(safeEntry);
					existingKeys.add(key);
					entryCount++;
				}

				if (backupData.allNotes) {
					for (const note of backupData.allNotes) {
						await db.weeklyNotes.put(note);
						notesCount++;
					}
				}

				if (backupData.allTicketStats) {
					for (const stat of backupData.allTicketStats) {
						await db.ticketStats.put(stat);
						ticketCount++;
					}
				}

				if (backupData.allDayMeta) {
					for (const meta of backupData.allDayMeta) {
						await db.dayMeta.put(meta);
					}
				}
			}
		},
	);

	return { entries: entryCount, notes: notesCount, tickets: ticketCount };
}

/* Export the raw db instance for advanced operations if needed */
export { db };
