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
} from "./utils.js";
import {
	getEntriesForDateRange,
	getWeeklyNotes,
	importTeamMemberData,
	getTeamMemberList,
} from "./db.js";

/* ============================================================================
 * CONSTANTS
 * ========================================================================= */

const HANDLE_DB_NAME = "chronos-sync-handles";
const HANDLE_DB_VERSION = 1;
const HANDLE_STORE = "handles";

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
export async function connectSyncFolder(purpose = "export") {
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
			mode: purpose === "export" ? "readwrite" : "read",
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

		/* Generate filename and write to the folder */
		const filename = generateExportFilename(state.settings.name, weekKey);
		const fileHandle = await handle.getFileHandle(filename, { create: true });
		const writable = await fileHandle.createWritable();
		await writable.write(JSON.stringify(exportData, null, 2));
		await writable.close();

		console.log(`Auto-exported ${filename} to sync folder`);
		return true;
	} catch (err) {
		console.warn("Auto-export failed:", err.message);
		return false;
	}
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
		const d = new Date(firstDate);

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
			/* Only process .json files */
			if (entry.kind !== "file" || !name.endsWith(".json")) continue;

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
