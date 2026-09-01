/* ============================================================================
 * app.js — Pulse Main Application Controller
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
	migrateAdminSplit,
	getTicketStatsForRange,
} from "./db.js";
import { initTracker, getCurrentWeekDates } from "./tracker.js";
import { initSettings } from "./settings.js";
import { initStats, getStatsContext, cleanupStats } from "./stats.js";
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
 * Reads the currently displayed week directly from the tracker module's
 * state, instead of reverse-engineering it from the nav label text (which
 * silently stamped the current year and broke across a year boundary, and
 * fell back to "now" whenever the tracker view wasn't rendered).
 * Returns null if the tracker hasn't rendered yet.
 */
function getTrackerWeekDates() {
	return getCurrentWeekDates();
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
window.state = state; // TEMP — for console testing only, remove before shipping

/* ============================================================================
 * INITIALIZATION
 * --------------------------------------------------------------------------
 * Runs once when the page loads. Sets up the app, checks for first-launch
 * onboarding, and renders the initial view.
 * ========================================================================= */

async function init() {
	/* Load user settings and tier mappings from IndexedDB */
	state.settings = await getUserSettings();

	/* Verify manager role is still authenticated */
	if (state.settings.role === "manager") {
		const { MANAGER_NAMES } = await import("./config.js");
		const isManagerName = MANAGER_NAMES.includes(
			(state.settings.name || "").toLowerCase(),
		);
		const hasAuth = localStorage.getItem("chronos-manager-auth") === "true";

		if (!isManagerName || !hasAuth) {
			/* Revoke manager access if name changed or auth cleared */
			state.settings.role = "contributor";
			const { saveUserSettings } = await import("./db.js");
			await saveUserSettings(state.settings);
			localStorage.removeItem("chronos-manager-auth");
		}
	}

	state.tierMap = await getTierMap();
	updateExportReportVisibility();

	/* One-time migration: convert zendesk_admin entries to admin */
	await migrateZendeskToAdmin();
	await migrateAdminSplit();

	/* ================================================================
	 * RESTORE CHECK
	 * Note whether local data was missing at load. If so, lock outbound
	 * sync writes immediately and — once we have a name to look up —
	 * check the sync folder for a backup before anything else happens.
	 * ================================================================ */
	const { hasAnyData } = await import("./db.js");
	state.needsRestoreCheck = !(await hasAnyData());

	if (state.needsRestoreCheck) {
		const { lockSyncWrites } = await import("./sync.js");
		lockSyncWrites();

		/* If the name already survived (a partial-eviction case rather
		 * than a full wipe), we can check for a backup immediately.
		 * Otherwise this waits — showOnboarding's save handler calls
		 * maybeOfferRestore once a name has been entered. */
		if (state.settings.name) {
			await maybeOfferRestore(state.settings.name);
		}
	}

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

	await updateSyncIndicator();

	initInfoBubbles();
	initCategoryHelp();
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

	saveBtn.addEventListener("click", async () => {
		const { capitalizeName, hashString } = await import("./utils.js");
		const { MANAGER_NAMES, MANAGER_HASH } = await import("./config.js");

		const name = capitalizeName(input.value.trim());
		if (!name) {
			input.focus();
			return;
		}
		input.value = name;

		/* Check if this is a manager name */
		const isManagerName = MANAGER_NAMES.includes(name.toLowerCase());
		let role = "contributor";

		if (isManagerName) {
			const passcode = prompt(
				"This name requires manager access. Enter the passcode:",
			);
			if (passcode) {
				const hash = await hashString(passcode);
				if (hash === MANAGER_HASH) {
					role = "manager";
					localStorage.setItem("chronos-manager-auth", "true");
				} else {
					alert("Incorrect passcode. You will be set up as a contributor.");
				}
			}
		}

		/* Persist the name and role to settings */
		state.settings.name = name;
		state.settings.role = role;
		await saveUserSettings(state.settings);
		updateExportReportVisibility();

		/* If local data was empty at load, check for a backup now that
		 * we have a name to look up. Runs before the banner disappears. */
		if (state.needsRestoreCheck) {
			await maybeOfferRestore(name);
		}

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

/**
 * maybeOfferRestore
 * Checks the sync folder (read-only) for a backup matching this name,
 * and — only on explicit confirmation — restores it. Always resolves by
 * unlocking sync writes, whether or not a restore actually happened.
 * Reuses the existing restore-overlay markup.
 *
 * @param {string} name
 */
async function maybeOfferRestore(name) {
	const overlay = document.getElementById("restore-overlay");
	const spinner = document.getElementById("restore-spinner");
	const restoreMsg = document.getElementById("restore-message");
	const restoreSub = document.getElementById("restore-sub");
	const connectBtn = document.getElementById("restore-connect-btn");
	const restoreBtn = document.getElementById("restore-confirm-btn");
	const skipBtn = document.getElementById("restore-skip-btn");

	const {
		isSyncSupported,
		getSyncStatus,
		connectSyncFolder,
		checkForBackup,
		autoRestoreFromBackup,
		unlockSyncWrites,
	} = await import("./sync.js");

	/* Always unlock on the way out, however this resolves */
	const finish = () => {
		unlockSyncWrites();
		overlay?.classList.add("hidden");
		spinner?.classList.remove("hidden"); /* reset for next time */
		connectBtn?.classList.add("hidden");
		restoreBtn?.classList.add("hidden");
		skipBtn?.classList.add("hidden");
	};

	if (!isSyncSupported()) return finish();

	overlay?.classList.remove("hidden");
	if (restoreMsg) restoreMsg.textContent = "Checking for a backup...";
	if (restoreSub) restoreSub.textContent = "";

	const status = await getSyncStatus("export");

	/* Runs the actual backup lookup once we're connected read-only */
	async function runBackupCheck() {
		spinner?.classList.remove("hidden"); /* checking the file is real work */
		const backup = await checkForBackup(name);
		spinner?.classList.add(
			"hidden",
		); /* result is in — nothing running until a click */

		if (!backup.found) {
			if (restoreMsg) restoreMsg.textContent = "No backup found";
			if (restoreSub) restoreSub.textContent = backup.error || "Starting fresh";
			setTimeout(finish, 2000);
			return;
		}

		/* Show what's there and wait for explicit confirmation */
		if (restoreMsg)
			restoreMsg.textContent = `Backup found: ${backup.entryCount} entries`;
		if (restoreSub) {
			restoreSub.textContent = backup.exportDate
				? `Last saved ${new Date(backup.exportDate).toLocaleDateString()} — restore it?`
				: "Restore it?";
		}

		restoreBtn?.classList.remove("hidden");
		skipBtn?.classList.remove("hidden");

		restoreBtn.onclick = async () => {
			restoreBtn.classList.add("hidden");
			skipBtn?.classList.add("hidden");
			spinner?.classList.remove("hidden"); /* restoring is real work */
			const result = await autoRestoreFromBackup(name);
			if (result.success) {
				/* Re-run migration against the data that just arrived — the
				 * guard would otherwise stay set from the earlier no-op
				 * pass against the empty database. */
				localStorage.removeItem("chronos-admin-split-migrated");
				await migrateAdminSplit();

				state.settings = await getUserSettings();
				state.tierMap = await getTierMap();

				if (restoreMsg) restoreMsg.textContent = "Data restored!";
				if (restoreSub)
					restoreSub.textContent = `Recovered ${result.entries} entries`;
			} else {
				if (restoreMsg) restoreMsg.textContent = "Restore failed";
				if (restoreSub) restoreSub.textContent = result.error || "";
			}
			setTimeout(finish, 1500);
		};

		skipBtn.onclick = () => finish();
	}

	/* No folder connected yet — this needs a user gesture, so show a
	 * prompt rather than firing the picker on its own. */
	if (!status.connected) {
		if (restoreMsg)
			restoreMsg.textContent = "Have you used Pulse on this device before?";
		if (restoreSub)
			restoreSub.textContent = "Connect your sync folder to check for a backup";
		spinner?.classList.add(
			"hidden",
		); /* nothing running — waiting on the person */
		connectBtn?.classList.remove("hidden");

		if (connectBtn) {
			connectBtn.onclick = async () => {
				connectBtn.classList.add("hidden");
				spinner?.classList.remove("hidden"); /* connecting is real work again */
				const result = await connectSyncFolder("export", { readOnly: true });
				if (!result.success) return finish();
				await runBackupCheck();
			};
		}
		return; /* wait for the click — do not finish yet */
	}

	await runBackupCheck();
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
	/* If we're leaving the stats view, stop its team-data auto-refresh so it
	 * doesn't keep polling the sync folder while on the tracker/settings.
	 * state.currentView still holds the *previous* view here (it's updated below). */
	if (state.currentView === VIEWS.STATS && viewId !== VIEWS.STATS) {
		cleanupStats();
	}

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

	await updateNotesReminder();

	await updateSyncIndicator();
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
 * updateSyncIndicator
 * Shows a small sync status icon in the header.
 * Green = syncing, amber = needs permission, hidden = not connected.
 */
async function updateSyncIndicator() {
	const indicator = document.getElementById("sync-indicator");
	const dot = document.getElementById("sync-dot");
	const label = document.getElementById("sync-label");
	if (!indicator || !dot || !label) return;

	try {
		const { isSyncSupported, getSyncStatus } = await import("./sync.js");
		if (!isSyncSupported()) {
			indicator.classList.add("hidden");
			return;
		}

		/* Check export folder status (relevant for everyone) */
		const exportStatus = await getSyncStatus("export");

		/* Also check import folder for managers */
		const isManager = state.settings.role === "manager";
		const importStatus = isManager ? await getSyncStatus("import") : null;

		if (!exportStatus.connected && (!importStatus || !importStatus.connected)) {
			/* Nothing connected — show grey "not connected" */
			indicator.classList.remove("hidden");
			dot.style.background = "var(--text-placeholder)";
			label.textContent = "Sync off";
			indicator.title = "Click to connect a sync folder in Settings";
			indicator.onclick = () => {
				document.querySelector('.nav-btn[data-view="settings"]')?.click() ||
					document.getElementById("nav-settings")?.click();
			};
			return;
		}

		/* Something is connected — check permissions */
		const exportOk = exportStatus.connected && exportStatus.hasPermission;
		const importOk =
			!isManager || !importStatus?.connected || importStatus?.hasPermission;

		if (exportOk && importOk) {
			/* All good — green dot */
			indicator.classList.remove("hidden");

			/* Check backup freshness */
			const { getBackupAge } = await import("./sync.js");
			const backupAge = getBackupAge();
			const staleThreshold = 24 * 60 * 60 * 1000; /* 24 hours */

			if (backupAge !== null && backupAge > staleThreshold) {
				dot.style.background = "var(--warning)";
				label.textContent = "Backup stale";
				const hoursAgo = Math.round(backupAge / (60 * 60 * 1000));
				indicator.title = `Last backup: ${hoursAgo}h ago. Make an edit to trigger a fresh backup.`;
				indicator.style.cursor = "default";
				indicator.onclick = null;
			} else {
				dot.style.background = "var(--positive)";
				label.textContent = "Syncing";
				const lastBackup =
					backupAge !== null
						? `Last backup: ${Math.round(backupAge / 60000)} min ago`
						: "No backup yet";
				indicator.title = `Auto-syncing to ${exportStatus.name}. ${lastBackup}`;
				indicator.style.cursor = "default";
				indicator.onclick = null;
			}
			indicator.onclick = null;
			indicator.style.cursor = "default";
		} else {
			/* Connected but needs permission — amber dot, click to grant */
			indicator.classList.remove("hidden");
			dot.style.background = "var(--warning)";
			label.textContent = "Sync paused";
			indicator.title = "Click to grant file access";
			indicator.style.cursor = "pointer";
			indicator.onclick = async () => {
				try {
					const { connectSyncFolder, getSyncStatus: refresh } =
						await import("./sync.js");
					/* Re-request permission by verifying the stored handle */
					if (exportStatus.connected && !exportStatus.hasPermission) {
						await connectSyncFolder("export");
					}
					if (importStatus?.connected && !importStatus?.hasPermission) {
						await connectSyncFolder("import");
					}
					/* Refresh the indicator */
					await updateSyncIndicator();
				} catch (e) {
					console.warn("Permission request failed:", e.message);
				}
			};
		}
	} catch (e) {
		/* sync.js not available */
		indicator.classList.add("hidden");
	}
}

/**
 * updateNotesReminder
 * Shows a sticky banner reminding users to fill out weekly notes.
 * Appears on Friday or later (including Monday if they missed it).
 * Can be snoozed for a configurable number of hours.
 */
async function updateNotesReminder() {
	/* Remove existing banner */
	const existing = document.getElementById("notes-reminder");
	if (existing) existing.remove();

	/* Check if snoozed */
	const snoozedUntil = localStorage.getItem("chronos-notes-snoozed-until");
	if (snoozedUntil && Date.now() < parseInt(snoozedUntil)) return;

	/* Managers don't need the notes reminder */
	if (state.settings.role === "manager") return;

	/* Only show on Friday or if last week's notes are empty */
	const now = new Date();
	const today = now.getDay(); /* 0=Sun, 1=Mon ... 5=Fri, 6=Sat */

	const { getWeeklyNotes } = await import("./db.js");
	const { getISOWeekKey, getWeekDates } = await import("./utils.js");

	/* Check current week's notes */
	const currentWeekKey = getISOWeekKey(now);
	const currentNotes = await getWeeklyNotes(currentWeekKey);
	const currentHasNotes =
		currentNotes &&
		(currentNotes.wins?.trim() ||
			currentNotes.losses?.trim() ||
			currentNotes.issues?.trim() ||
			currentNotes.customerMeetings?.trim());

	/* Check previous week's notes (for Monday reminder) */
	const lastWeek = new Date(now);
	lastWeek.setDate(lastWeek.getDate() - 7);
	const lastWeekKey = getISOWeekKey(lastWeek);
	const lastNotes = await getWeeklyNotes(lastWeekKey);
	const lastHasNotes =
		lastNotes &&
		(lastNotes.wins?.trim() ||
			lastNotes.losses?.trim() ||
			lastNotes.issues?.trim() ||
			lastNotes.customerMeetings?.trim());

	/* Determine if we should show the banner */
	let showBanner = false;
	let bannerMessage = "";

	if (today >= 5 && !currentHasNotes) {
		/* Friday or weekend — current week notes empty */
		showBanner = true;
		bannerMessage =
			"It's end of week — don't forget to fill out your weekly notes before you go.";
	} else if (today >= 1 && today <= 3 && !lastHasNotes) {
		/* Mon-Wed — last week's notes still empty */
		const skippedWeeks = JSON.parse(
			localStorage.getItem("chronos-notes-skipped-weeks") || "[]",
		);
		if (!skippedWeeks.includes(lastWeekKey)) {
			showBanner = true;
			bannerMessage = `Last week's notes (${lastWeekKey}) are still empty. Take a moment to fill them in.`;
		}
	}

	if (!showBanner) return;

	const banner = document.createElement("div");
	banner.id = "notes-reminder";
	banner.style.cssText = `
    position: sticky;
    top: 0;
    z-index: 200;
    background: var(--bg-card);
    border: 0.5px solid var(--accent-border);
    border-radius: 10px;
    padding: 10px 16px;
    margin: 0 0 12px 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  `;

	banner.innerHTML = `
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="width: 24px; height: 24px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <span style="font-size: 12px; color: white; font-weight: 500;">N</span>
      </div>
      <div>
        <div style="font-size: 13px; font-weight: 500; color: var(--text-primary);">Weekly notes</div>
        <div style="font-size: 11px; color: var(--text-muted);">${bannerMessage}</div>
      </div>
    </div>
    <div style="display: flex; gap: 6px; flex-shrink: 0;">
      <div style="display: flex; gap: 6px; flex-shrink: 0;">
		<button id="reminder-open-notes" style="
			font-size: 12px; font-weight: 500; padding: 5px 14px; border-radius: 8px;
			background: var(--accent); color: white; border: none; cursor: pointer; font-family: inherit;
		">Open notes</button>
		${
			!currentHasNotes && lastHasNotes
				? ""
				: !lastHasNotes && today >= 1 && today <= 3
					? `
		<button id="reminder-skip-week" style="
			font-size: 12px; padding: 5px 10px; border-radius: 8px;
			background: none; color: var(--text-muted); border: 0.5px solid var(--border-default); cursor: pointer; font-family: inherit;
		">Skip this week</button>
		`
					: ""
		}
		<button id="reminder-snooze" style="
			font-size: 12px; padding: 5px 10px; border-radius: 8px;
			background: none; color: var(--text-muted); border: 0.5px solid var(--border-default); cursor: pointer; font-family: inherit;
			position: relative;
		">Snooze ▾</button>
		<button id="reminder-dismiss" style="
			font-size: 14px; padding: 2px 8px; border-radius: 8px;
			background: none; color: var(--text-placeholder); border: none; cursor: pointer; font-family: inherit;
		">×</button>
    </div>
  `;

	/* Insert after the header */
	const header = document.getElementById("app-header");
	if (header && header.parentNode) {
		header.parentNode.insertBefore(banner, header.nextSibling);
	}

	/* Open notes button */
	banner.querySelector("#reminder-open-notes").addEventListener("click", () => {
		banner.remove();
		/* Press N to open notes panel */
		const notesBtn =
			document.getElementById("btn-notes") ||
			document.getElementById("stats-notes-btn");
		if (notesBtn) notesBtn.click();
	});

	/* Snooze dropdown */
	banner.querySelector("#reminder-snooze").addEventListener("click", (e) => {
		e.stopPropagation();
		/* Remove existing snooze menu */
		const existingMenu = document.getElementById("snooze-menu");
		if (existingMenu) {
			existingMenu.remove();
			return;
		}

		const menu = document.createElement("div");
		menu.id = "snooze-menu";
		menu.style.cssText = `
      position: absolute; top: calc(100% + 4px); right: 0;
      background: var(--bg-dropdown); border: 0.5px solid var(--border-default);
      border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      padding: 4px; z-index: 300; min-width: 140px;
    `;

		const options = [
			{ label: "1 hour", hours: 1 },
			{ label: "4 hours", hours: 4 },
			{ label: "Until tomorrow", hours: 24 },
			{ label: "Until Friday", hours: null },
		];

		options.forEach((opt) => {
			const btn = document.createElement("button");
			btn.style.cssText = `
        display: block; width: 100%; text-align: left; padding: 6px 10px;
        font-size: 12px; border: none; background: none; cursor: pointer;
        font-family: inherit; color: var(--text-primary); border-radius: 6px;
      `;
			btn.textContent = opt.label;
			btn.onmouseover = () => (btn.style.background = "var(--bg-surface)");
			btn.onmouseout = () => (btn.style.background = "none");
			btn.addEventListener("click", () => {
				let snoozeMs;
				if (opt.hours) {
					snoozeMs = opt.hours * 60 * 60 * 1000;
				} else {
					/* Until Friday — calculate ms until next Friday 9am */
					const fri = new Date();
					const daysUntilFri = (5 - fri.getDay() + 7) % 7 || 7;
					fri.setDate(fri.getDate() + daysUntilFri);
					fri.setHours(9, 0, 0, 0);
					snoozeMs = fri.getTime() - Date.now();
				}
				localStorage.setItem(
					"chronos-notes-snoozed-until",
					String(Date.now() + snoozeMs),
				);
				banner.remove();
			});
			menu.appendChild(btn);
		});

		banner.querySelector("#reminder-snooze").style.position = "relative";
		banner.querySelector("#reminder-snooze").appendChild(menu);

		/* Close menu on outside click */
		const closeMenu = () => {
			menu.remove();
			document.removeEventListener("click", closeMenu);
		};
		setTimeout(() => document.addEventListener("click", closeMenu), 0);
	});

	/* Dismiss — just removes for this page load */
	banner.querySelector("#reminder-dismiss").addEventListener("click", () => {
		banner.remove();
	});

	/* Skip week — permanently dismiss the reminder for a specific week */
	banner.querySelector("#reminder-skip-week")?.addEventListener("click", () => {
		const skipped = JSON.parse(
			localStorage.getItem("chronos-notes-skipped-weeks") || "[]",
		);
		skipped.push(lastWeekKey);
		localStorage.setItem(
			"chronos-notes-skipped-weeks",
			JSON.stringify(skipped),
		);
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
			onboarding: e.onboarding || false,
			ticketLink: e.ticketLink || "",
			formerPOS: e.formerPOS || "",
			analyticsCount: e.analyticsCount || 0,
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
		ticketStats: await getTicketStatsForExport(startDate, endDate),
		tierMap: state.tierMap,
	};

	const filename = generateExportFilename(state.settings.name, weekKey);
	downloadJSON(exportData, filename);

	/* Mark this week as exported and update the reminder banner */
	markWeekExported(weekKey);

	await updateNotesReminder();

	await updateSyncIndicator();
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
					onboarding: e.onboarding || false,
					ticketLink: e.ticketLink || "",
					formerPOS: e.formerPOS || "",
					analyticsCount: e.analyticsCount || 0,
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

	await updateNotesReminder();
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
		onboarding,
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
	const onboardingPct =
		tracked > 0 ? Math.round((onboarding / tracked) * 100) : 0;

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
        <div class="metric-label">Onboarding ratio</div>
        <div class="metric-value">${onboardingPct}%</div>
        <div class="metric-sub">${onboarding} of ${tracked} hrs</div>
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
      <span>Pro-Serv Pulse — ${isAllTeam ? "Team" : "Individual"} Report</span>
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

/**
 * initInfoBubbles
 * Sets up global hover handlers for info bubble tooltips.
 */
function initInfoBubbles() {
	let activePopover = null;
	let activeBubble = null;

	document.addEventListener("mouseover", (e) => {
		const bubble = e.target.closest(".info-bubble");
		if (!bubble || bubble === activeBubble) return;

		/* Close any existing popover */
		if (activePopover) {
			activePopover.remove();
			activePopover = null;
			activeBubble = null;
		}

		const text = bubble.dataset.help;
		if (!text) return;

		const popover = document.createElement("div");
		popover.className = "info-popover";
		popover.innerHTML = text;
		document.body.appendChild(popover);

		/* Position below the bubble */
		const rect = bubble.getBoundingClientRect();
		const popRect = popover.getBoundingClientRect();
		let left = rect.left + rect.width / 2 - popRect.width / 2;
		let top = rect.bottom + 6;

		/* Keep within viewport */
		if (left < 8) left = 8;
		if (left + popRect.width > window.innerWidth - 8) {
			left = window.innerWidth - popRect.width - 8;
		}
		/* --- Vertical placement: below by default, flip above only if it fits --- */
		/* If the popover would spill past the BOTTOM edge of the viewport... */
		if (top + popRect.height > window.innerHeight - 8) {
			/* Calculate where the popover's top would be if placed ABOVE the bubble */
			const aboveTop = rect.top - popRect.height - 6;
			/* Only flip above if there's genuinely room up there (won't clip the top).
			 * If it wouldn't fit above either (tall popover near the top of the
			 * screen), we leave it below and let the clamps below sort it out. */
			if (aboveTop >= 8) {
				top = aboveTop;
			}
		}

		/* --- Final viewport clamps (run regardless of above/below choice) --- */
		/* Pull up if it overflows the bottom edge... */
		if (top + popRect.height > window.innerHeight - 8) {
			top = window.innerHeight - popRect.height - 8;
		}
		/* ...then pull down if it overflows the top edge. This runs LAST on
		 * purpose: for a popover taller than the viewport, the top edge wins,
		 * so the start of the content is always visible rather than clipped. */
		if (top < 8) {
			top = 8;
		}

		popover.style.left = `${left}px`;
		popover.style.top = `${top}px`;
		activePopover = popover;
		activeBubble = bubble;
	});

	document.addEventListener("mouseout", (e) => {
		const bubble = e.target.closest(".info-bubble");
		if (bubble && bubble === activeBubble) {
			/* Small delay so the popover doesn't flicker */
			setTimeout(() => {
				if (activePopover) {
					activePopover.remove();
					activePopover = null;
					activeBubble = null;
				}
			}, 150);
		}
	});
}

/**
 * initCategoryHelp
 * Shows a small description popover when the user deliberately hovers a category
 * option in the edit dropdown. Set up once at startup; works for dropdowns created
 * later because it listens on `document` (event delegation).
 *
 * Two deliberate UX choices live here:
 *   1. A hover-intent DELAY, so sliding the cursor down the list to click an
 *      option doesn't flash a popover on every row it passes.
 *   2. SIDE placement (beside the whole dropdown), so the popover never covers
 *      the option list, the form fields, or the cursor.
 */
function initCategoryHelp() {
	let currentOption = null; // The option we're currently tracking (or null)
	let popover = null; // The visible popover element (or null)
	let showTimer = null; // Pending "show after delay" timer
	const SHOW_DELAY = 350; // ms of deliberate hover before the popover appears
	const GAP = 10; // px gap between the dropdown and the popover

	/* Cancel any pending show and remove the popover. Safe to call anytime. */
	function clearPopover() {
		if (showTimer) {
			clearTimeout(showTimer);
			showTimer = null;
		}
		if (popover) {
			popover.remove();
			popover = null;
		}
	}

	document.addEventListener("mouseover", (e) => {
		/* Only react to category options that carry help text */
		const option = e.target.closest(".dropdown-option[data-help]");
		if (!option) return;

		/* Moving WITHIN the same option (e.g. dot → label) shouldn't restart
		 * the delay timer — ignore it. */
		if (option === currentOption) return;
		currentOption = option;

		/* New option: clear whatever was showing/pending, then start the timer */
		clearPopover();
		const text = option.dataset.help;
		if (!text) return; // categories with no help (e.g. lunch) show nothing

		showTimer = setTimeout(() => {
			/* Build the popover, reusing the existing .info-popover styling */
			popover = document.createElement("div");
			popover.className = "info-popover";
			popover.innerHTML = text;
			document.body.appendChild(popover);

			/* Measure the hovered option and the popover itself */
			const optRect = option.getBoundingClientRect();
			const popRect = popover.getBoundingClientRect();

			/* Horizontal: prefer directly to the LEFT of the hovered option.
			 * If the left placement would clip off the left edge of the screen,
			 * flip to the RIGHT of the option instead. */
			let left = optRect.left - popRect.width - GAP;
			if (left < 8) {
				left = optRect.right + GAP;
			}
			/* Last-resort clamp so it can't run off the right edge either */
			if (left + popRect.width > window.innerWidth - 8) {
				left = window.innerWidth - popRect.width - 8;
			}

			/* Vertical: line up with the hovered option, then clamp to the
			 * viewport (top edge wins, so the start is always visible). */
			let top = optRect.top;
			if (top + popRect.height > window.innerHeight - 8) {
				top = window.innerHeight - popRect.height - 8;
			}
			if (top < 8) top = 8;

			popover.style.left = `${left}px`;
			popover.style.top = `${top}px`;
		}, SHOW_DELAY);
	});

	document.addEventListener("mouseout", (e) => {
		const option = e.target.closest(".dropdown-option[data-help]");
		if (!option) return;

		/* Moving to something still inside the same option isn't "leaving" it */
		if (e.relatedTarget && option.contains(e.relatedTarget)) return;

		/* Actually left the option → tear everything down */
		if (option === currentOption) {
			currentOption = null;
			clearPopover();
		}
	});
}

/**
 * getTicketStatsForExport
 * Returns ticket stats for the date range, formatted for export.
 */
async function getTicketStatsForExport(startDate, endDate) {
	const { getTicketStatsForRange } = await import("./db.js");
	const stats = await getTicketStatsForRange(startDate, endDate);
	return stats.map((s) => ({
		date: s.date,
		queueSize: s.queueSize,
		newTickets: s.newTickets,
		closedTickets: s.closedTickets,
		customisations: s.customisations || 0,
		templates: s.templates || 0,
		otherTools: s.otherTools || 0,
	}));
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

export function markHasData() {
	localStorage.setItem("chronos-has-data", "true");
}

/* ============================================================================
 * BOOT
 * --------------------------------------------------------------------------
 * Kick off initialization when the DOM is ready.
 * ========================================================================= */

document.addEventListener("DOMContentLoaded", init);
