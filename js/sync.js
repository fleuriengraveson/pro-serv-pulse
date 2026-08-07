/* ============================================================================
 * sync.js — File System Access API Sync
 * ============================================================================
 * Handles automatic export to and import from a shared Google Drive folder
 * using the File System Access API. No backend, no API keys required.
 *
 * Contributors: auto-writes their weekly JSON on every save
 * Managers: auto-reads all JSON files on page load
 *
 * Requires Chrome or Edge. Falls back gracefully on unsupported browsers.
 * ========================================================================= */

import { CATEGORIES } from "./config.js";
import {
	getISOWeekKey,
	getWeekDateRange,
	getWeekDates,
	formatDateISO,
	generateExportFilename,
	parseDate,
} from "./utils.js";
import {
	getEntriesForDateRange,
	getWeeklyNotes,
	importTeamMemberData,
	getTeamMemberList,
	getTicketStatsForRange,
	getDayMetaForRange,
	getEntryCount,
	hasAnyData,
	restoreFromPersonalBackup,
} from "./db.js";

/* ============================================================================
 * CONSTANTS
 * ========================================================================= */

const HANDLE_DB_NAME = "chronos-sync-handles";
const HANDLE_DB_VERSION = 1;
const HANDLE_STORE = "handles";

/* ============================================================================
 * SYNC WRITE LOCK
 * --------------------------------------------------------------------------
 * While a restore decision is pending (empty local data, checking the
 * sync folder for a backup before doing anything else), outbound writes
 * must not run — otherwise a save that happens mid-decision could
 * overwrite a real backup with blank/partial local data.
 * Defaults to unlocked: normal users with existing data are never affected.
 * ========================================================================= */
let writesLocked = false;

export function lockSyncWrites() {
	writesLocked = true;
}

export function unlockSyncWrites() {
	writesLocked = false;
}

/* ============================================================================
 * BROWSER SUPPORT CHECK
 * ========================================================================= */

/**
 * isSyncSupported
 * Returns true if the File System Access API is available.
 */
export function isSyncSupported() {
	return "showDirectoryPicker" in window;
}

/* ============================================================================
 * HANDLE PERSISTENCE
 * --------------------------------------------------------------------------
 * We store the directory handle in IndexedDB so it persists across
 * page loads. The browser still prompts for permission once per session.
 * ========================================================================= */

/**
 * openHandleDB
 * Opens (or creates) the IndexedDB database for storing directory handles.
 */
function openHandleDB() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(HANDLE_STORE)) {
				db.createObjectStore(HANDLE_STORE);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/**
 * saveHandle
 * Persists a directory handle to IndexedDB.
 *
 * @param {string} key - 'export' or 'import'
 * @param {FileSystemDirectoryHandle} handle
 */
async function saveHandle(key, handle) {
	const db = await openHandleDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HANDLE_STORE, "readwrite");
		tx.objectStore(HANDLE_STORE).put(handle, key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/**
 * loadHandle
 * Retrieves a stored directory handle from IndexedDB.
 *
 * @param {string} key - 'export' or 'import'
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
async function loadHandle(key) {
	const db = await openHandleDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HANDLE_STORE, "readonly");
		const request = tx.objectStore(HANDLE_STORE).get(key);
		request.onsuccess = () => resolve(request.result || null);
		request.onerror = () => reject(request.error);
	});
}

/**
 * removeHandle
 * Removes a stored directory handle from IndexedDB.
 *
 * @param {string} key - 'export' or 'import'
 */
async function removeHandle(key) {
	const db = await openHandleDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HANDLE_STORE, "readwrite");
		tx.objectStore(HANDLE_STORE).delete(key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/* ============================================================================
 * PERMISSION VERIFICATION
 * --------------------------------------------------------------------------
 * Each browser session requires the user to re-grant permission.
 * We verify the handle and prompt if needed.
 * ========================================================================= */

/**
 * verifyPermission
 * Checks if we have read/write access to a stored handle.
 * Prompts the user if permission has expired (new session).
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {boolean} readWrite - true for write access, false for read only
 * @returns {Promise<boolean>} true if permission granted
 */
async function verifyPermission(handle, readWrite = true) {
	const options = { mode: readWrite ? "readwrite" : "read" };

	/* Check if we already have permission */
	if ((await handle.queryPermission(options)) === "granted") {
		return true;
	}

	/* Request permission — this shows the browser prompt */
	if ((await handle.requestPermission(options)) === "granted") {
		return true;
	}

	return false;
}

/* ============================================================================
 * FOLDER CONNECTION
 * --------------------------------------------------------------------------
 * These functions handle the initial folder picker dialog.
 * ========================================================================= */

/**
 * connectSyncFolder
 * Opens the native folder picker and stores the selected handle.
 * Used by both contributors (export) and managers (import).
 *
 * @param {string} purpose - 'export' or 'import'
 * @returns {Promise<{ success: boolean, name: string }>}
 */
export async function connectSyncFolder(
	purpose = "export",
	{ readOnly = false } = {},
) {
	if (!isSyncSupported()) {
		return {
			success: false,
			name: "",
			error: "File System Access API not supported in this browser.",
		};
	}

	try {
		/* Show the native folder picker */
		const handle = await window.showDirectoryPicker({
			mode: readOnly ? "read" : purpose === "export" ? "readwrite" : "read",
			startIn: "documents",
		});

		/* Store the handle for persistence */
		await saveHandle(purpose, handle);

		return { success: true, name: handle.name };
	} catch (err) {
		/* User cancelled the picker */
		if (err.name === "AbortError") {
			return { success: false, name: "", error: "Folder selection cancelled." };
		}
		return { success: false, name: "", error: err.message };
	}
}

/**
 * disconnectSyncFolder
 * Removes the stored handle for a given purpose.
 *
 * @param {string} purpose - 'export' or 'import'
 */
export async function disconnectSyncFolder(purpose = "export") {
	await removeHandle(purpose);
}

/**
 * getSyncStatus
 * Returns the current connection status for a purpose.
 *
 * @param {string} purpose - 'export' or 'import'
 * @returns {Promise<{ connected: boolean, name: string, hasPermission: boolean }>}
 */
export async function getSyncStatus(purpose = "export") {
	if (!isSyncSupported()) {
		return {
			connected: false,
			name: "",
			hasPermission: false,
			supported: false,
		};
	}

	const handle = await loadHandle(purpose);
	if (!handle) {
		return {
			connected: false,
			name: "",
			hasPermission: false,
			supported: true,
		};
	}

	/* Check if we still have permission (without prompting) */
	const mode = purpose === "export" ? "readwrite" : "read";
	const permission = await handle.queryPermission({ mode });

	return {
		connected: true,
		name: handle.name,
		hasPermission: permission === "granted",
		supported: true,
	};
}

/* ============================================================================
 * FULL BACKUP DEBOUNCE
 * --------------------------------------------------------------------------
 * autoExportWeek() used to call autoExportFullBackup() on every save, which
 * re-reads every entry ever and rewrites the whole backup file each time —
 * heavy churn on a Drive-synced folder. Coalesce automatic full-backup
 * rewrites to at most once per FULL_BACKUP_DEBOUNCE_MS. A trailing flush on
 * tab hide/close still fires so a save right before closing isn't lost —
 * autoExportFullBackup's own atomic write (createWritable + close) is
 * untouched, so the file itself is never left partially written.
 * ========================================================================= */
const FULL_BACKUP_DEBOUNCE_MS = 20000; // coalesce to at most once per 20s
let fullBackupTimer = null;
let fullBackupPendingState = null;

function scheduleFullBackup(state) {
	fullBackupPendingState = state;
	if (fullBackupTimer) return; // a flush is already scheduled
	fullBackupTimer = setTimeout(() => {
		fullBackupTimer = null;
		const stateToFlush = fullBackupPendingState;
		fullBackupPendingState = null;
		if (stateToFlush) autoExportFullBackup(stateToFlush);
	}, FULL_BACKUP_DEBOUNCE_MS);
}

/* Flush immediately when the tab is closing/hiding, so a debounced write
 * isn't dropped by a crash or tab close before the timer fires. */
function flushPendingFullBackup() {
	if (fullBackupTimer) {
		clearTimeout(fullBackupTimer);
		fullBackupTimer = null;
	}
	const stateToFlush = fullBackupPendingState;
	fullBackupPendingState = null;
	if (stateToFlush) autoExportFullBackup(stateToFlush);
}

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") flushPendingFullBackup();
});
window.addEventListener("beforeunload", flushPendingFullBackup);

/**
 * checkForBackup
 * Read-only inspection of the sync folder: looks for this user's backup
 * file and reports what's in it, without importing anything. Used before
 * offering a restore, so the person can see what they'd be recovering.
 *
 * @param {string} userName
 * @returns {Promise<{found:boolean, entryCount?:number, exportDate?:string, error?:string}>}
 */
export async function checkForBackup(userName) {
	const handle = await loadHandle("export");
	if (!handle) return { found: false, error: "No folder connected" };

	const hasPermission = await verifyPermission(
		handle,
		false,
	); /* read-only check */
	if (!hasPermission) return { found: false, error: "Permission denied" };

	const safeName = (userName || "unnamed")
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/[^a-z0-9_]/g, "");
	try {
		const fileHandle = await handle.getFileHandle(`${safeName}_backup.json`, {
			create: false,
		});
		const file = await fileHandle.getFile();
		const data = JSON.parse(await file.text());
		return {
			found: true,
			entryCount: data.allEntries?.length || 0,
			exportDate: data.exportDate || null,
		};
	} catch (e) {
		return { found: false, error: "No backup file found for this name" };
	}
}

/* ============================================================================
 * AUTO-EXPORT (CONTRIBUTORS)
 * --------------------------------------------------------------------------
 * Writes the current week's data to the connected folder.
 * Called automatically on every entry save.
 * ========================================================================= */

/**
 * autoExportWeek
 * Writes the current week's export JSON to the sync folder.
 * Silently fails if no folder is connected or permission denied.
 *
 * @param {Object} state - The app state (settings, tierMap)
 * @param {Date} refDate - A date within the week to export (defaults to today)
 * @returns {Promise<boolean>} true if export succeeded
 */
export async function autoExportWeek(state, refDate = new Date()) {
	try {
		/* Refuse to write while a restore decision is pending */
		if (writesLocked) {
			console.log("Sync write skipped — restore decision pending");
			return false;
		}
		const handle = await loadHandle("export");
		if (!handle) return false;

		/* Verify we have write permission (may prompt user) */
		const hasPermission = await verifyPermission(handle, true);
		if (!hasPermission) return false;

		/* Build the export data */
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
			settings: { ...state.settings },
			entries: entries.map((e) => ({
				date: e.date,
				timeSlot: e.timeSlot,
				category: e.category,
				subCategory: e.subCategory || "",
				billable: e.billable || false,
				merchant: e.merchant || "",
				urgent: e.urgent || false,
				onboarding: e.onboarding || false,
				ticketLink: e.ticketLink || "",
				formerPOS: e.formerPOS || "",
				notes: e.notes || "",
			})),
			ticketStats: (await getTicketStatsForRange(startDate, endDate)).map(
				(s) => ({
					date: s.date,
					queueSize: s.queueSize,
					newTickets: s.newTickets,
					closedTickets: s.closedTickets,
				}),
			),
			/* Per-day metadata (queue duty flags) for this week */
			dayMeta: (await getDayMetaForRange(startDate, endDate)).map((m) => ({
				date: m.date,
				onQueue: m.onQueue || false,
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

		/* Generate filename and write to the folder */
		const filename = generateExportFilename(state.settings.name, weekKey);

		/* Overwrite protection: if a file already exists for this week with
		 * real entries, don't replace it with an empty one. Mirrors the
		 * protection autoExportFullBackup already has, applied per-week. */
		if (entries.length === 0) {
			try {
				const existingHandle = await handle.getFileHandle(filename, {
					create: false,
				});
				const existingFile = await existingHandle.getFile();
				const existingData = JSON.parse(await existingFile.text());
				if (existingData.entries?.length > 0) {
					console.warn(
						`Skipping export of ${filename}: would overwrite ${existingData.entries.length} entries with 0`,
					);
					return false;
				}
			} catch (e) {
				/* No existing file for this week — safe to write, nothing there to lose */
			}
		}

		const fileHandle = await handle.getFileHandle(filename, { create: true });
		const writable = await fileHandle.createWritable();
		await writable.write(JSON.stringify(exportData, null, 2));
		await writable.close();

		console.log(`Auto-exported ${filename} to sync folder`);

		/* Also update the full backup — debounced so heavy edit bursts
		 * (range fills, batch deletes) don't rewrite it on every save. */
		scheduleFullBackup(state);

		return true;
	} catch (err) {
		console.warn("Auto-export failed:", err.message);
		return false;
	}
}

/**
 * autoExportFullBackup
 * Writes directly to the backup file; createWritable() only commits the
 * new contents atomically on close(), so the file on disk is never left
 * partially written or briefly missing.
 *
 * @param {Object} state - The app state
 * @returns {Promise<boolean>} true if backup succeeded
 */
export async function autoExportFullBackup(state) {
	try {
		/* Refuse to write while a restore decision is pending */
		if (writesLocked) {
			console.log("Sync write skipped — restore decision pending");
			return false;
		}
		const handle = await loadHandle("export");
		if (!handle) return false;

		const hasPermission = await verifyPermission(handle, true);
		if (!hasPermission) return false;

		/* Gather all data */
		const allEntries = await getEntriesForDateRange("2000-01-01", "2099-12-31");

		/* Safety: don't write an empty backup */
		if (allEntries.length === 0) {
			console.warn("Skipping full backup: no local entries");
			return false;
		}

		/* Gather notes for all weeks */
		const weekKeys = [
			...new Set(
				allEntries.map((e) => {
					const d = parseDate(e.date); // local-time parse; new Date() reads YYYY-MM-DD as UTC
					return getISOWeekKey(d);
				}),
			),
		];

		const allNotes = [];
		for (const weekKey of weekKeys) {
			const notes = await getWeeklyNotes(weekKey);
			if (notes) {
				allNotes.push({ weekKey, ...notes });
			}
		}

		/* Gather all ticket stats */
		const allTicketStats = await getTicketStatsForRange(
			"2000-01-01",
			"2099-12-31",
		);
		/* Gather all day metadata (queue duty flags) */
		const allDayMeta = await getDayMetaForRange("2000-01-01", "2099-12-31");

		const backupData = {
			exportDate: new Date().toISOString(),
			appVersion: "1.0.0",
			format: "full-backup",
			entryCount: allEntries.length,
			contributor: {
				name: state.settings.name || "Unnamed",
				role: state.settings.role,
			},
			settings: { ...state.settings },
			tierMap: state.tierMap,
			allEntries,
			allNotes,
			allTicketStats: allTicketStats.map((s) => ({
				date: s.date,
				queueSize: s.queueSize,
				newTickets: s.newTickets,
				closedTickets: s.closedTickets,
			})),
			allDayMeta: allDayMeta.map((m) => ({
				date: m.date,
				onQueue: m.onQueue || false,
			})),
		};

		const safeName = (state.settings.name || "unnamed")
			.toLowerCase()
			.replace(/\s+/g, "_")
			.replace(/[^a-z0-9_]/g, "");
		const backupFilename = `${safeName}_backup.json`;

		/* Overwrite protection: check existing backup size */
		try {
			const existingHandle = await handle.getFileHandle(backupFilename, {
				create: false,
			});
			const existingFile = await existingHandle.getFile();
			const existingText = await existingFile.text();
			const existingData = JSON.parse(existingText);

			if (
				existingData.entryCount &&
				allEntries.length < existingData.entryCount
			) {
				/* Any decrease is treated as unsafe, not just a >50% drop.
				 * Rationale: this file holds one user's ENTIRE history and
				 * is the only recovery copy. Real entry counts should only
				 * grow over time; a lower count almost always means this
				 * device is behind (e.g. hasn't restored/synced yet), not
				 * that the user actually deleted a chunk of their history.
				 * The old 50%-drop-only threshold let smaller-but-real
				 * data loss (e.g. 100 -> 60 entries) through silently.
				 * If a genuine bulk deletion is ever needed, that should
				 * go through a separate, explicit "force backup" action
				 * rather than through this automatic write path. */
				console.warn(
					`Backup protection: new backup has ${allEntries.length} entries vs existing ${existingData.entryCount} (a decrease of ${existingData.entryCount - allEntries.length}). Skipping write to avoid overwriting a fuller backup.`,
				);
				return false;
			}
		} catch (e) {
			/* No existing backup — safe to write */
		}

		/* Safe write: createWritable() commits atomically on close().
		 * The FS Access API buffers everything written to a hidden swap
		 * file under the hood, and only replaces the target file's actual
		 * contents once close() resolves successfully. The on-disk backup
		 * is therefore either the old complete backup or the new complete
		 * backup — never a deleted/missing/half-written state.
		 *
		 * This is why the previous "write temp, delete old, copy temp over"
		 * sequence was both unnecessary and unsafe: it manually recreated
		 * the exact delete-then-write gap that createWritable() already
		 * avoids for us. If write() or close() throws below, the existing
		 * backup file on disk is left completely untouched. */
		const backupHandle = await handle.getFileHandle(backupFilename, {
			create: true,
		});
		const backupWritable = await backupHandle.createWritable();
		await backupWritable.write(JSON.stringify(backupData, null, 2));
		await backupWritable.close();

		/* Store backup timestamp */
		localStorage.setItem("chronos-last-backup", Date.now().toString());

		console.log(
			`Full backup saved: ${allEntries.length} entries, ${allNotes.length} notes`,
		);
		return true;
	} catch (err) {
		console.warn("Full backup failed:", err.message);
		return false;
	}
}

/**
 * autoRestoreFromBackup
 * Reads the user's backup file from the sync folder and restores
 * it into the local database. Called when empty database is detected.
 *
 * @param {string} userName - The user's name (to find their backup file)
 * @returns {Promise<{ success: boolean, entries: number, error: string }>}
 */
export async function autoRestoreFromBackup(userName) {
	try {
		const handle = await loadHandle("export");
		if (!handle)
			return { success: false, entries: 0, error: "No sync folder connected" };

		const hasPermission = await verifyPermission(handle, false);
		if (!hasPermission)
			return { success: false, entries: 0, error: "Permission denied" };

		const safeName = (userName || "unnamed")
			.toLowerCase()
			.replace(/\s+/g, "_")
			.replace(/[^a-z0-9_]/g, "");
		const backupFilename = `${safeName}_backup.json`;

		/* Try to read the full backup file */
		let backupData = null;
		try {
			const fileHandle = await handle.getFileHandle(backupFilename, {
				create: false,
			});
			const file = await fileHandle.getFile();
			const text = await file.text();
			backupData = JSON.parse(text);
		} catch (e) {
			/* No full backup — try to reconstruct from weekly files */
			console.log("No full backup found, trying weekly files...");
		}

		if (!backupData) {
			/* Scan for weekly export files matching this user */
			const weeklyData = {
				weeks: [],
				contributor: { name: userName },
				settings: null,
				tierMap: null,
			};

			for await (const [name, entry] of handle.entries()) {
				if (entry.kind !== "file" || !name.endsWith(".json")) continue;
				if (!name.toLowerCase().startsWith(safeName)) continue;
				if (name.includes("backup")) continue;

				try {
					const file = await entry.getFile();
					const text = await file.text();
					const data = JSON.parse(text);

					if (data.settings && !weeklyData.settings) {
						weeklyData.settings = data.settings;
					}
					if (data.tierMap && !weeklyData.tierMap) {
						weeklyData.tierMap = data.tierMap;
					}
					if (data.entries && data.entries.length > 0) {
						weeklyData.weeks.push({
							weekKey: data.weekKey,
							entries: data.entries,
							weeklyNotes: data.weeklyNotes,
							ticketStats: data.ticketStats,
							dayMeta: data.dayMeta || [],
						});
					}
				} catch (e) {
					console.warn(`Failed to read ${name}:`, e.message);
				}
			}

			if (weeklyData.weeks.length > 0) {
				backupData = weeklyData;
			}
		}

		if (!backupData) {
			return { success: false, entries: 0, error: "No backup files found" };
		}

		/* Validate the backup data */
		const hasEntries =
			backupData.allEntries?.length > 0 || backupData.weeks?.length > 0;
		if (!hasEntries) {
			return { success: false, entries: 0, error: "Backup file is empty" };
		}

		/* Restore the data */
		const result = await restoreFromPersonalBackup(backupData);

		console.log(
			`Restored from backup: ${result.entries} entries, ${result.notes} notes, ${result.tickets} ticket stats`,
		);
		return { success: true, entries: result.entries, error: "" };
	} catch (err) {
		console.warn("Auto-restore failed:", err.message);
		return { success: false, entries: 0, error: err.message };
	}
}

/**
 * getBackupAge
 * Returns milliseconds since the last successful backup.
 * Returns null if no backup has been recorded.
 *
 * @returns {number|null}
 */
export function getBackupAge() {
	const timestamp = localStorage.getItem("chronos-last-backup");
	if (!timestamp) return null;
	return Date.now() - parseInt(timestamp);
}

/**
 * autoExportAllWeeks
 * Writes all tracked weeks to the sync folder.
 * Called on first folder connection to backfill historical data.
 *
 * @param {Object} state - The app state (settings, tierMap)
 * @returns {Promise<number>} Number of weeks exported
 */
export async function autoExportAllWeeks(state) {
	try {
		const handle = await loadHandle("export");
		if (!handle) return 0;

		const hasPermission = await verifyPermission(handle, true);
		if (!hasPermission) return 0;

		const { getFirstTrackedDate } = await import("./db.js");
		const firstDate = await getFirstTrackedDate();
		if (!firstDate) return 0;

		const now = new Date();
		const d = parseDate(firstDate); // local-time parse; new Date() reads YYYY-MM-DD as UTC

		/* Rewind to Monday of the first week */
		const dayOfWeek = d.getDay();
		const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
		d.setDate(d.getDate() + mondayOffset);

		let count = 0;

		while (d <= now) {
			const weekKey = getISOWeekKey(d);
			const { startDate, endDate } = getWeekDateRange(d);
			const entries = await getEntriesForDateRange(startDate, endDate);

			/* Only export weeks that have data */
			if (entries.length > 0) {
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
					ticketStats: await (async () => {
						const stats = await getTicketStatsForRange(startDate, endDate);
						return stats.map((s) => ({
							date: s.date,
							queueSize: s.queueSize,
							newTickets: s.newTickets,
							closedTickets: s.closedTickets,
						}));
					})(),
					/* Per-day metadata (queue duty flags) for this week */
					dayMeta: await (async () => {
						const metas = await getDayMetaForRange(startDate, endDate);
						return metas.map((m) => ({
							date: m.date,
							onQueue: m.onQueue || false,
						}));
					})(),
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
				const fileHandle = await handle.getFileHandle(filename, {
					create: true,
				});
				const writable = await fileHandle.createWritable();
				await writable.write(JSON.stringify(exportData, null, 2));
				await writable.close();
				count++;
			}

			d.setDate(d.getDate() + 7);
		}

		console.log(`Backfill complete: ${count} weeks exported to sync folder`);
		return count;
	} catch (err) {
		console.warn("Backfill export failed:", err.message);
		return 0;
	}
}

/* ============================================================================
 * OOO OVERRIDES (MANAGER-SET, SHARED ACROSS ALL MANAGERS)
 * --------------------------------------------------------------------------
 * Lives in its own file in the same shared folder used for team import.
 * Kept completely separate from each contributor's own weekly export so a
 * manager's OOO call can never alter anyone's actual tracked-hours data.
 * ========================================================================= */

const OOO_OVERRIDES_FILENAME = "_pulse-ooo-overrides.json";

/**
 * readOOOOverrides
 * Reads the shared OOO overrides file from the import folder.
 * Returns {} if the folder isn't connected or the file doesn't exist yet.
 *
 * @returns {Promise<Object>} { [name]: { [weekKey]: { status, setBy, setAt } } }
 */
export async function readOOOOverrides() {
	try {
		const handle = await loadHandle("import");
		if (!handle) return {};

		const hasPermission = await verifyPermission(handle, false);
		if (!hasPermission) return {};

		const fileHandle = await handle.getFileHandle(OOO_OVERRIDES_FILENAME, {
			create: false,
		});
		const file = await fileHandle.getFile();
		return JSON.parse(await file.text());
	} catch (err) {
		/* Most common case: file doesn't exist yet — normal until the first
		 * override is ever written. */
		return {};
	}
}

/**
 * writeOOOOverride
 * Adds or updates a single member+week override in the shared file.
 * Re-reads the file immediately before writing to minimize (not fully
 * eliminate) the chance of clobbering a different manager's concurrent edit.
 *
 * @param {string} name    - Team member's name
 * @param {string} weekKey - ISO week key, e.g. '2026-W32'
 * @param {string} status  - 'ooo' or 'dismissed'
 * @param {string} setBy   - Name of the manager making the change
 * @returns {Promise<boolean>} true on success
 */
export async function writeOOOOverride(name, weekKey, status, setBy) {
	try {
		const handle = await loadHandle("import");
		if (!handle) return false;

		/* Writing requires escalating this normally-read-only handle to
		 * readwrite. The browser will prompt the first time in a session. */
		const hasPermission = await verifyPermission(handle, true);
		if (!hasPermission) return false;

		let current = {};
		try {
			const existingHandle = await handle.getFileHandle(
				OOO_OVERRIDES_FILENAME,
				{ create: false },
			);
			const file = await existingHandle.getFile();
			current = JSON.parse(await file.text());
		} catch {
			current = {};
		}

		if (!current[name]) current[name] = {};
		current[name][weekKey] = {
			status,
			setBy,
			setAt: new Date().toISOString(),
		};

		const fileHandle = await handle.getFileHandle(OOO_OVERRIDES_FILENAME, {
			create: true,
		});
		const writable = await fileHandle.createWritable();
		await writable.write(JSON.stringify(current, null, 2));
		await writable.close();
		return true;
	} catch (err) {
		console.warn("Failed to write OOO override:", err.message);
		return false;
	}
}

/**
 * clearOOOOverride
 * Removes a single member+week override from the shared file — used by the
 * manager's right-click "Clear OOO" and by the automatic re-activation when
 * a member later logs real hours for a week that was marked OOO.
 *
 * @param {string} name    - Team member's name
 * @param {string} weekKey - ISO week key, e.g. '2026-W32'
 * @returns {Promise<boolean>} true on success
 */
export async function clearOOOOverride(name, weekKey) {
	try {
		const handle = await loadHandle("import");
		if (!handle) return false;

		const hasPermission = await verifyPermission(handle, true);
		if (!hasPermission) return false;

		let current = {};
		try {
			const existingHandle = await handle.getFileHandle(
				OOO_OVERRIDES_FILENAME,
				{ create: false },
			);
			const file = await existingHandle.getFile();
			current = JSON.parse(await file.text());
		} catch {
			return true; /* nothing to clear */
		}

		if (current[name]) {
			delete current[name][weekKey];
			if (Object.keys(current[name]).length === 0) delete current[name];
		}

		const fileHandle = await handle.getFileHandle(OOO_OVERRIDES_FILENAME, {
			create: true,
		});
		const writable = await fileHandle.createWritable();
		await writable.write(JSON.stringify(current, null, 2));
		await writable.close();
		return true;
	} catch (err) {
		console.warn("Failed to clear OOO override:", err.message);
		return false;
	}
}

/* ============================================================================
 * AUTO-IMPORT (MANAGERS)
 * --------------------------------------------------------------------------
 * Scans the connected folder for all JSON files and imports them.
 * Called automatically on page load when viewing the stats page.
 * ========================================================================= */

/**
 * autoImportTeamData
 * Reads all JSON files from the sync folder and imports them
 * as team data. Returns a summary of what was imported.
 *
 * @returns {Promise<{ success: boolean, imported: number, updated: number, errors: number }>}
 */
export async function autoImportTeamData() {
	try {
		const handle = await loadHandle("import");
		if (!handle) return { success: false, imported: 0, updated: 0, errors: 0 };

		/* Verify we have read permission (may prompt user) */
		const hasPermission = await verifyPermission(handle, false);
		if (!hasPermission)
			return { success: false, imported: 0, updated: 0, errors: 0 };

		let imported = 0;
		let updated = 0;
		let errors = 0;

		/* Iterate through all files in the folder */
		for await (const [name, entry] of handle.entries()) {
			/* Only process .json files, and skip the OOO overrides ledger —
			 * it's a manager-only file, not a contributor export. */
			if (entry.kind !== "file" || !name.endsWith(".json")) continue;
			if (name === OOO_OVERRIDES_FILENAME) continue;

			try {
				const file = await entry.getFile();
				const text = await file.text();
				const data = JSON.parse(text);

				/* Handle multi-week format */
				if (
					data.format === "multi-week" &&
					data.weeks &&
					data.contributor?.name
				) {
					for (const week of data.weeks) {
						const weekData = {
							...data,
							weekKey: week.weekKey,
							startDate: week.startDate,
							endDate: week.endDate,
							entries: week.entries,
							weeklyNotes: week.weeklyNotes,
							dayMeta: week.dayMeta || [],
						};
						const isNew = await importTeamMemberData(
							data.contributor.name,
							week.weekKey,
							weekData,
						);
						if (isNew) imported++;
						else updated++;
					}
					continue;
				}

				/* Handle single-week format */
				if (!data.contributor?.name || !data.weekKey || !data.entries) continue;

				const isNew = await importTeamMemberData(
					data.contributor.name,
					data.weekKey,
					data,
				);
				if (isNew) imported++;
				else updated++;
			} catch (err) {
				console.warn(`Failed to import ${name}:`, err.message);
				errors++;
			}
		}

		console.log(
			`Auto-import complete: ${imported} new, ${updated} updated, ${errors} errors`,
		);
		return { success: true, imported, updated, errors };
	} catch (err) {
		console.warn("Auto-import failed:", err.message);
		return { success: false, imported: 0, updated: 0, errors: 0 };
	}
}
