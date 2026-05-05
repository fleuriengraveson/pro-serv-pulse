/* ============================================================================
 * settings.js — User Settings View
 * ============================================================================
 * Renders the settings/preferences panel where users can configure:
 *   - Name (persists in exports)
 *   - Role (contributor / manager)
 *   - Work hours (start and end times)
 *   - Lunch time and duration
 *   - Optional field toggles (merchant, former POS)
 *   - Tier mappings (manager only)
 *
 * Settings are persisted in IndexedDB and applied immediately.
 * ========================================================================= */

import {
	CATEGORIES,
	DEFAULT_TIER_MAP,
	TIERS,
	TIME_DEFAULTS,
} from "./config.js";
import { saveUserSettings, getTierMap, saveTierMap } from "./db.js";

/* ============================================================================
 * MODULE STATE
 * ========================================================================= */

let appState = null; // Reference to global app state
let onChangeCallback = null; // Callback to notify app.js when settings change

/* ============================================================================
 * INITIALIZATION
 * ========================================================================= */

/**
 * initSettings
 * Called by app.js when the settings view becomes active.
 *
 * @param {Object} state      - Global app state
 * @param {Function} onChange  - Callback fired after settings are saved
 */
export async function initSettings(state, onChange) {
	appState = state;
	onChangeCallback = onChange;
	await renderSettings();
}

/* ============================================================================
 * RENDER
 * ========================================================================= */

async function renderSettings() {
	const container = document.getElementById("view-settings");
	const settings = appState.settings;
	const tierMap = await getTierMap();
	const isManager = settings.role === "manager";

	container.innerHTML = `
    <div class="max-w-2xl">

      <!-- Header -->
      <h2 class="text-base font-semibold text-stone-900 mb-1">Settings</h2>
      <p class="text-sm text-stone-400 mb-6">Configure your preferences. Changes are saved automatically.</p>

      <!-- ================================================================
        PROFILE SECTION
        ================================================================ -->
      <div class="mb-8">
        <h3 class="text-xs font-medium text-stone-400 uppercase tracking-wider mb-3">Profile</h3>
        <div class="space-y-4 bg-white rounded-xl border border-stone-200 p-5">

          <!-- Name -->
          <div>
            <label for="setting-name" class="block text-sm font-medium text-stone-600 mb-1">Name</label>
            <p class="text-xs text-stone-400 mb-1.5">This appears on your exports so managers can identify your data.</p>
            <input type="text" id="setting-name"
                   value="${settings.name || ""}"
                   placeholder="Your full name"
                   class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 bg-surface-50 focus:ring-2 focus:ring-chronos-300 focus:border-chronos-300" />
          </div>

          <!-- Role -->
          <div>
            <label for="setting-role" class="block text-sm font-medium text-stone-600 mb-1">Role</label>
            <p class="text-xs text-stone-400 mb-1.5">Managers can edit tier mappings and access the team dashboard.</p>
            <select id="setting-role"
                    class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 bg-surface-50 focus:ring-2 focus:ring-chronos-300">
              <option value="contributor" ${settings.role === "contributor" ? "selected" : ""}>Individual contributor</option>
              <option value="manager" ${settings.role === "manager" ? "selected" : ""}>Manager</option>
            </select>
          </div>

        </div>
      </div>

      <!-- ================================================================
        WORK HOURS SECTION
        ================================================================ -->
      <div class="mb-8">
        <h3 class="text-xs font-medium text-stone-400 uppercase tracking-wider mb-3">Work hours</h3>
        <div class="space-y-4 bg-white rounded-xl border border-stone-200 p-5">

          <!-- Start / End hours -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label for="setting-start-hour" class="block text-sm font-medium text-stone-600 mb-1">Day starts at</label>
              <select id="setting-start-hour"
                      class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 bg-surface-50">
                ${generateHourOptions(settings.dayStartHour || TIME_DEFAULTS.dayStartHour)}
              </select>
            </div>
            <div>
              <label for="setting-end-hour" class="block text-sm font-medium text-stone-600 mb-1">Day ends at</label>
              <select id="setting-end-hour"
                      class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 bg-surface-50">
                ${generateHourOptions(settings.dayEndHour || TIME_DEFAULTS.dayEndHour)}
              </select>
            </div>
          </div>

          <!-- Lunch time -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label for="setting-lunch-hour" class="block text-sm font-medium text-stone-600 mb-1">Lunch starts at</label>
              <select id="setting-lunch-hour"
                      class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 bg-surface-50">
                ${generateHourOptions(settings.lunchStartHour || TIME_DEFAULTS.lunchStartHour)}
              </select>
            </div>
            <div>
              <label for="setting-lunch-blocks" class="block text-sm font-medium text-stone-600 mb-1">Lunch duration</label>
              <select id="setting-lunch-blocks"
                      class="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 bg-surface-50">
                <option value="1" ${(settings.lunchBlocks || 2) === 1 ? "selected" : ""}>30 minutes</option>
                <option value="2" ${(settings.lunchBlocks || 2) === 2 ? "selected" : ""}>1 hour</option>
                <option value="3" ${(settings.lunchBlocks || 2) === 3 ? "selected" : ""}>1.5 hours</option>
              </select>
            </div>
          </div>

        </div>
      </div>

      <!-- ================================================================
        OPTIONAL FIELDS SECTION
        ================================================================ -->
      <div class="mb-8">
        <h3 class="text-xs font-medium text-stone-400 uppercase tracking-wider mb-3">Optional fields</h3>
        <div class="space-y-3 bg-white rounded-xl border border-stone-200 p-5">

          <!-- Merchant toggle -->
          <label class="flex items-center justify-between cursor-pointer">
            <div>
              <span class="text-sm font-medium text-stone-600">Merchant tracking</span>
              <p class="text-xs text-stone-400">Show a merchant name field on each time block.</p>
            </div>
            <input type="checkbox" id="setting-merchant"
                   ${settings.enableMerchant ? "checked" : ""}
                   class="w-4 h-4 rounded border-stone-300 text-chronos-500 focus:ring-chronos-300" />
          </label>

          <!-- Former POS toggle -->
          <label class="flex items-center justify-between cursor-pointer border-t border-stone-100 pt-3">
            <div>
              <span class="text-sm font-medium text-stone-600">Former POS tracking</span>
              <p class="text-xs text-stone-400">Show a former POS field on each time block.</p>
            </div>
            <input type="checkbox" id="setting-formerpos"
                   ${settings.enableFormerPOS ? "checked" : ""}
                   class="w-4 h-4 rounded border-stone-300 text-chronos-500 focus:ring-chronos-300" />
          </label>

        </div>
      </div>

      <!-- ================================================================
        VISIBLE CATEGORIES
        ================================================================ -->
      <div class="mb-8">
        <h3 class="text-xs font-medium text-stone-400 uppercase tracking-wider mb-3">Visible categories</h3>
        <p class="text-xs text-stone-400 mb-3">Choose which categories appear in your tracker dropdown. Hidden categories won't be lost from existing data.</p>
        <div class="bg-white rounded-xl border border-stone-200 p-5 space-y-2">
          ${CATEGORIES.filter(
						(c) => c.id !== "lunch" && c.id !== "ooo" && c.id !== "other",
					)
						.map((cat) => {
							const isHidden = (settings.hiddenCategories || []).includes(
								cat.id,
							);
							return `
              <label class="flex items-center justify-between cursor-pointer ${cat.id !== CATEGORIES.filter((c) => c.id !== "lunch" && c.id !== "ooo" && c.id !== "other")[0].id ? "border-t border-stone-100 pt-2" : ""}">
                <div class="flex items-center gap-2">
                  <div class="w-2.5 h-2.5 rounded-sm" style="background: var(${cat.cssVar})"></div>
                  <span class="text-sm text-stone-600">${cat.label}</span>
                </div>
                <input type="checkbox" class="category-toggle w-4 h-4 rounded border-stone-300 text-chronos-500 focus:ring-chronos-300"
                       data-category="${cat.id}"
                       ${!isHidden ? "checked" : ""} />
              </label>
            `;
						})
						.join("")}
        </div>
      </div>

      <!-- ================================================================
        TIER MAPPINGS (MANAGER ONLY)
        ================================================================ -->
      ${
				isManager
					? `
      <div class="mb-8">
        <h3 class="text-xs font-medium text-stone-400 uppercase tracking-wider mb-3">Tier mappings</h3>
        <p class="text-xs text-stone-400 mb-3">Assign each work category to a tier. This affects all team reporting.</p>
        <div class="bg-white rounded-xl border border-stone-200 p-5 space-y-2">
          ${CATEGORIES.map(
						(cat) => `
            <div class="flex items-center justify-between py-1.5 ${cat.id !== CATEGORIES[0].id ? "border-t border-stone-50" : ""}">
              <div class="flex items-center gap-2">
                <div class="w-2 h-2 rounded-sm" style="background: ${cat.hex}"></div>
                <span class="text-sm text-stone-600">${cat.label}</span>
              </div>
              <select class="tier-select px-2 py-1 text-xs rounded-lg border border-stone-200 bg-surface-50"
                      data-category="${cat.id}">
                <option value="null" ${tierMap[cat.id] === null ? "selected" : ""}>Excluded (no tier)</option>
                <option value="1" ${tierMap[cat.id] === 1 ? "selected" : ""}>Tier 1 — Customer-facing</option>
                <option value="2" ${tierMap[cat.id] === 2 ? "selected" : ""}>Tier 2 — Internal duties</option>
                <option value="3" ${tierMap[cat.id] === 3 ? "selected" : ""}>Tier 3 — Other</option>
              </select>
            </div>
          `,
					).join("")}

          <div class="pt-3 border-t border-stone-100">
            <button id="btn-reset-tiers"
                    class="text-xs text-stone-400 hover:text-red-500 transition-colors">
              Reset to defaults
            </button>
          </div>
        </div>
      </div>
      `
					: `
      <div class="mb-8">
        <h3 class="text-xs font-medium text-stone-400 uppercase tracking-wider mb-3">Tier mappings</h3>
        <div class="bg-white rounded-xl border border-stone-200 p-5">
          <p class="text-sm text-stone-400">Tier mappings can only be edited by managers. Contact your manager to request changes.</p>
        </div>
      </div>
      `
			}

      <!-- ================================================================
        TEAM DATA IMPORT (MANAGER ONLY)
        ================================================================ -->
      ${
				isManager
					? `
      <div class="mb-8">
        <h3 class="text-xs font-medium text-stone-400 uppercase tracking-wider mb-3">Team data</h3>
        <div class="bg-white rounded-xl border border-stone-200 p-5">

          <!-- Import zone -->
          <div id="import-dropzone"
               style="border: 2px dashed var(--border-default); border-radius: 10px; padding: 24px; text-align: center; cursor: pointer; transition: all 0.15s ease;">
            <div style="font-size: 13px; font-weight: 500; color: var(--text-primary); margin-bottom: 4px;">
              Drop team export files here
            </div>
            <div style="font-size: 12px; color: var(--text-muted);">
              or click to browse — accepts multiple .json files
            </div>
            <input type="file" id="import-files" accept=".json" multiple class="hidden" />
          </div>

          <!-- Import status -->
          <div id="import-status" style="margin-top: 12px;"></div>

          <!-- Imported team members list -->
          <div id="team-members-list" style="margin-top: 16px;"></div>

        </div>
      </div>
      `
					: ""
			}

			<!-- ================================================================
        SYNC FOLDER CONNECTION
        ================================================================ -->
      <div class="mb-8">
        <h3 class="text-xs font-medium text-stone-400 uppercase tracking-wider mb-3">Sync</h3>
        <div class="bg-white rounded-xl border border-stone-200 p-5">

          <!-- Export folder (everyone) -->
          <div style="margin-bottom: 16px;">
            <div style="font-size: 13px; font-weight: 500; color: var(--text-primary); margin-bottom: 4px;">
              Auto-export folder
            </div>
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">
              Weekly exports are automatically saved to this folder when you track time.
            </div>
            <div id="sync-export-status" style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            </div>
            <div style="display: flex; gap: 6px;">
              <button id="sync-export-connect" style="
                font-size: 12px; font-weight: 500; padding: 6px 14px; border-radius: 8px;
                background: var(--accent); color: white; border: none; cursor: pointer; font-family: inherit;
              ">Connect folder</button>
              <button id="sync-export-disconnect" class="hidden" style="
                font-size: 12px; padding: 6px 14px; border-radius: 8px;
                background: none; color: var(--text-muted); border: 0.5px solid var(--border-default); cursor: pointer; font-family: inherit;
              ">Disconnect</button>
            </div>
          </div>

          ${
						isManager
							? `
          <!-- Import folder (manager only) -->
          <div style="border-top: 0.5px solid var(--border-default); padding-top: 16px;">
            <div style="font-size: 13px; font-weight: 500; color: var(--text-primary); margin-bottom: 4px;">
              Auto-import folder
            </div>
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">
              Team exports are automatically imported from this folder when you open Stats.
            </div>
            <div id="sync-import-status" style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            </div>
            <div style="display: flex; gap: 6px;">
              <button id="sync-import-connect" style="
                font-size: 12px; font-weight: 500; padding: 6px 14px; border-radius: 8px;
                background: var(--accent); color: white; border: none; cursor: pointer; font-family: inherit;
              ">Connect folder</button>
              <button id="sync-import-disconnect" class="hidden" style="
                font-size: 12px; padding: 6px 14px; border-radius: 8px;
                background: none; color: var(--text-muted); border: 0.5px solid var(--border-default); cursor: pointer; font-family: inherit;
              ">Disconnect</button>
            </div>
          </div>
          `
							: ""
					}

          <!-- Unsupported browser warning -->
          <div id="sync-unsupported" class="hidden" style="
            font-size: 12px; color: var(--warning-text); background: var(--warning-bg);
            padding: 8px 12px; border-radius: 8px; margin-top: 12px;
          ">
            Auto-sync requires Chrome or Edge. You can still export and import files manually.
          </div>
        </div>
      </div>

      <!-- ================================================================
        DATA MANAGEMENT
        ================================================================ -->
      <div class="mb-8">
        <h3 class="text-xs font-medium text-stone-400 uppercase tracking-wider mb-3">Data</h3>
        <div class="bg-white rounded-xl border border-stone-200 p-5 space-y-3">

          <div class="flex items-center justify-between">
            <div>
              <span class="text-sm font-medium text-stone-600">Export full backup</span>
              <p class="text-xs text-stone-400">Download all your data as a JSON file.</p>
            </div>
            <button id="btn-full-backup"
                    class="text-xs px-3 py-1.5 rounded-lg border border-stone-200 text-stone-500 hover:text-stone-700 hover:border-stone-300 transition-colors">
              Export
            </button>
          </div>

          <div class="flex items-center justify-between border-t border-stone-100 pt-3">
            <div>
              <span class="text-sm font-medium text-stone-600">Restore from backup</span>
              <p class="text-xs text-stone-400">Replace all local data with a backup file.</p>
            </div>
            <label class="text-xs px-3 py-1.5 rounded-lg border border-stone-200 text-stone-500 hover:text-stone-700 hover:border-stone-300 transition-colors cursor-pointer">
              Import
              <input type="file" id="btn-restore-backup" accept=".json" class="hidden" />
            </label>
          </div>

        </div>
      </div>

    </div>
  `;

	/* Attach event listeners */
	attachSettingsListeners();
}

/* ============================================================================
 * HELPERS
 * ========================================================================= */

/**
 * generateHourOptions
 * Generates <option> elements for hour selection dropdowns (6 AM to 10 PM).
 *
 * @param {number} selectedHour - The currently selected hour
 * @returns {string} HTML options string
 */
function generateHourOptions(selectedHour) {
	let html = "";
	for (let h = 6; h <= 22; h++) {
		const period = h >= 12 ? "PM" : "AM";
		const displayHour = h > 12 ? h - 12 : h === 0 ? 12 : h;
		const label = `${displayHour}:00 ${period}`;
		html += `<option value="${h}" ${h === selectedHour ? "selected" : ""}>${label}</option>`;
	}
	return html;
}

/* ============================================================================
 * EVENT LISTENERS
 * --------------------------------------------------------------------------
 * Auto-saves settings whenever any field changes.
 * ========================================================================= */

async function attachSettingsListeners() {
	const container = document.getElementById("view-settings");

	/* --- Auto-save on any input change --- */
	const saveFields = async () => {
		const settings = { ...appState.settings };

		/* Read all field values */
		settings.name =
			container.querySelector("#setting-name")?.value.trim() || "";
		settings.role =
			container.querySelector("#setting-role")?.value || "contributor";
		settings.dayStartHour =
			parseInt(container.querySelector("#setting-start-hour")?.value) ||
			TIME_DEFAULTS.dayStartHour;
		settings.dayEndHour =
			parseInt(container.querySelector("#setting-end-hour")?.value) ||
			TIME_DEFAULTS.dayEndHour;
		settings.lunchStartHour =
			parseInt(container.querySelector("#setting-lunch-hour")?.value) ||
			TIME_DEFAULTS.lunchStartHour;
		settings.lunchBlocks =
			parseInt(container.querySelector("#setting-lunch-blocks")?.value) ||
			TIME_DEFAULTS.lunchBlocks;
		settings.enableMerchant =
			container.querySelector("#setting-merchant")?.checked || false;
		settings.enableFormerPOS =
			container.querySelector("#setting-formerpos")?.checked || false;

		/* Persist to IndexedDB */
		await saveUserSettings(settings);

		/* Notify app.js so it can update cached state and refresh views */
		if (onChangeCallback) {
			onChangeCallback(settings);
		}
	};

	/* Debounced save — waits 300ms after the last keystroke */
	let saveTimeout;
	const debouncedSave = () => {
		clearTimeout(saveTimeout);
		saveTimeout = setTimeout(saveFields, 300);
	};

	/* Attach to all inputs */
	container.querySelectorAll("input, select").forEach((el) => {
		el.addEventListener("input", debouncedSave);
		el.addEventListener("change", debouncedSave);
	});

	/* --- Role change: re-render to show/hide tier mappings --- */
	container
		.querySelector("#setting-role")
		?.addEventListener("change", async () => {
			await saveFields();
			/* Small delay to let state propagate before re-render */
			setTimeout(() => renderSettings(), 100);
		});

	/* --- Tier mapping changes (manager only) --- */
	container.querySelectorAll(".tier-select").forEach((select) => {
		select.addEventListener("change", async () => {
			const tierMap = await getTierMap();
			tierMap[select.dataset.category] =
				select.value === "null" ? null : parseInt(select.value);
			await saveTierMap(tierMap);
			/* Update cached state */
			appState.tierMap = tierMap;
		});
	});

	/* --- Reset tiers to defaults --- */
	container
		.querySelector("#btn-reset-tiers")
		?.addEventListener("click", async () => {
			await saveTierMap({ ...DEFAULT_TIER_MAP });
			appState.tierMap = { ...DEFAULT_TIER_MAP };
			renderSettings(); // Re-render to update the dropdowns
		});

	/* --- Full backup export --- */
	container
		.querySelector("#btn-full-backup")
		?.addEventListener("click", async () => {
			const { exportAllData } = await import("./db.js");
			const data = await exportAllData();
			const { downloadJSON } = await import("./utils.js");
			const filename = `chronos_full_backup_${new Date().toISOString().slice(0, 10)}.json`;
			downloadJSON(data, filename);
		});

	/* --- Restore from backup --- */
	container
		.querySelector("#btn-restore-backup")
		?.addEventListener("change", async (e) => {
			const file = e.target.files[0];
			if (!file) return;

			/* Confirm before overwriting all data */
			if (
				!confirm(
					"This will replace ALL your local data with the backup file. Are you sure?",
				)
			) {
				e.target.value = "";
				return;
			}

			try {
				const { readJSONFile } = await import("./utils.js");
				const data = await readJSONFile(file);
				const { restoreFromBackup } = await import("./db.js");
				await restoreFromBackup(data);

				/* Reload settings and refresh */
				const { getUserSettings, getTierMap } = await import("./db.js");
				appState.settings = await getUserSettings();
				appState.tierMap = await getTierMap();

				alert("Backup restored successfully.");
				renderSettings();

				if (onChangeCallback) {
					onChangeCallback(appState.settings);
				}
			} catch (err) {
				alert(`Failed to restore backup: ${err.message}`);
			}

			e.target.value = "";
		});
	/* Category visibility toggles */
	container.querySelectorAll(".category-toggle").forEach((toggle) => {
		toggle.addEventListener("change", async () => {
			const settings = { ...appState.settings };
			const hidden = new Set(settings.hiddenCategories || []);

			if (toggle.checked) {
				hidden.delete(toggle.dataset.category);
			} else {
				hidden.add(toggle.dataset.category);
			}

			settings.hiddenCategories = [...hidden];
			await saveUserSettings(settings);

			if (onChangeCallback) {
				onChangeCallback(settings);
			}
		});
	});

	/* --- Team data import (manager only) --- */
	const dropzone = container.querySelector("#import-dropzone");
	const fileInput = container.querySelector("#import-files");

	if (dropzone && fileInput) {
		/* Click to browse */
		dropzone.addEventListener("click", () => fileInput.click());

		/* Drag and drop styling */
		dropzone.addEventListener("dragover", (e) => {
			e.preventDefault();
			dropzone.style.borderColor = "var(--accent)";
			dropzone.style.background = "var(--accent-light)";
		});
		dropzone.addEventListener("dragleave", () => {
			dropzone.style.borderColor = "var(--border-default)";
			dropzone.style.background = "none";
		});

		/* Handle dropped files */
		dropzone.addEventListener("drop", async (e) => {
			e.preventDefault();
			dropzone.style.borderColor = "var(--border-default)";
			dropzone.style.background = "none";
			await handleTeamImport(e.dataTransfer.files);
		});

		/* Handle file input change */
		fileInput.addEventListener("change", async (e) => {
			await handleTeamImport(e.target.files);
			e.target.value = "";
		});

		/* Load and display existing team members */
		loadTeamMembersList();
	}

	/**
	 * handleTeamImport
	 * Processes multiple dropped/selected JSON export files.
	 */
	async function handleTeamImport(files) {
		const statusEl = document.getElementById("import-status");
		if (!statusEl) return;

		const results = [];
		let successCount = 0;
		let updateCount = 0;
		let errorCount = 0;

		for (const file of files) {
			try {
				const { readJSONFile } = await import("./utils.js");
				const data = await readJSONFile(file);

				/* Validate the file has the expected structure */
				const { importTeamMemberData } = await import("./db.js");

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
						if (isNew) successCount++;
						else updateCount++;
					}
					results.push(
						`<div style="font-size: 12px; color: var(--positive);">${data.contributor.name} — ${data.weeks.length} weeks imported</div>`,
					);
					continue;
				}

				/* Handle single-week format */
				if (!data.contributor?.name || !data.weekKey || !data.entries) {
					results.push(
						`<div style="font-size: 12px; color: var(--danger);">${file.name} — invalid format</div>`,
					);
					errorCount++;
					continue;
				}

				const isNew = await importTeamMemberData(
					data.contributor.name,
					data.weekKey,
					data,
				);

				if (isNew) {
					results.push(
						`<div style="font-size: 12px; color: var(--positive);">${data.contributor.name} — ${data.weekKey} imported</div>`,
					);
					successCount++;
				} else {
					results.push(
						`<div style="font-size: 12px; color: var(--text-muted);">${data.contributor.name} — ${data.weekKey} updated</div>`,
					);
					updateCount++;
				}
			} catch (err) {
				results.push(
					`<div style="font-size: 12px; color: var(--danger);">${file.name} — ${err.message}</div>`,
				);
				errorCount++;
			}
		}

		/* Show summary */
		let summary = `<div style="font-size: 12px; font-weight: 500; margin-bottom: 6px;">`;
		const parts = [];
		if (successCount > 0) parts.push(`${successCount} imported`);
		if (updateCount > 0) parts.push(`${updateCount} updated`);
		if (errorCount > 0) parts.push(`${errorCount} failed`);
		summary += parts.join(", ") + "</div>";

		statusEl.innerHTML = summary + results.join("");

		/* Refresh team members list */
		loadTeamMembersList();
	}

	/**
	 * loadTeamMembersList
	 * Displays the list of imported team members in settings.
	 */
	async function loadTeamMembersList() {
		const listEl = document.getElementById("team-members-list");
		if (!listEl) return;

		const { getTeamMemberList } = await import("./db.js");
		const members = await getTeamMemberList();

		if (members.length === 0) {
			listEl.innerHTML =
				'<div style="font-size: 12px; color: var(--text-muted);">No team data imported yet.</div>';
			return;
		}

		let html = `
    <div style="font-size: 12px; font-weight: 500; color: var(--text-primary); margin-bottom: 8px;">
      Imported team members (${members.length})
    </div>
  `;

		members.forEach((m) => {
			html += `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-top: 0.5px solid var(--border-default);">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 28px; height: 28px; border-radius: 50%; background: var(--accent-light); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 500; color: var(--accent-text);">
            ${m.name
							.split(" ")
							.map((n) => n[0])
							.join("")
							.toUpperCase()
							.slice(0, 2)}
          </div>
          <div>
            <div style="font-size: 13px; font-weight: 500;">${m.name}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${m.weekCount} week${m.weekCount > 1 ? "s" : ""} — latest: ${m.lastImport}</div>
          </div>
        </div>
      </div>
    `;
		});

		listEl.innerHTML = html;
	}

	/* --- Sync folder connections --- */
	const {
		isSyncSupported,
		connectSyncFolder,
		disconnectSyncFolder,
		getSyncStatus,
	} = await import("./sync.js");

	/* Show unsupported warning if needed */
	if (!isSyncSupported()) {
		document.getElementById("sync-unsupported")?.classList.remove("hidden");
		document.getElementById("sync-export-connect")?.classList.add("hidden");
		if (document.getElementById("sync-import-connect")) {
			document.getElementById("sync-import-connect").classList.add("hidden");
		}
	}

	/* Render current sync status */
	async function updateSyncStatusUI() {
		const exportStatus = await getSyncStatus("export");
		const exportStatusEl = document.getElementById("sync-export-status");
		const exportConnectBtn = document.getElementById("sync-export-connect");
		const exportDisconnectBtn = document.getElementById(
			"sync-export-disconnect",
		);

		if (exportStatusEl) {
			if (exportStatus.connected) {
				exportStatusEl.innerHTML = `
          <div style="width: 8px; height: 8px; border-radius: 50%; background: ${exportStatus.hasPermission ? "var(--positive)" : "var(--warning)"};"></div>
          <span style="font-size: 12px; color: var(--text-primary); font-weight: 500;">${exportStatus.name}</span>
          <span style="font-size: 11px; color: var(--text-muted);">${exportStatus.hasPermission ? "Connected" : "Needs permission"}</span>
        `;
				exportConnectBtn?.classList.add("hidden");
				exportDisconnectBtn?.classList.remove("hidden");
			} else {
				exportStatusEl.innerHTML = `
          <div style="width: 8px; height: 8px; border-radius: 50%; background: var(--text-placeholder);"></div>
          <span style="font-size: 12px; color: var(--text-muted);">Not connected</span>
        `;
				exportConnectBtn?.classList.remove("hidden");
				exportDisconnectBtn?.classList.add("hidden");
			}
		}

		/* Import status (manager only) */
		const importStatusEl = document.getElementById("sync-import-status");
		const importConnectBtn = document.getElementById("sync-import-connect");
		const importDisconnectBtn = document.getElementById(
			"sync-import-disconnect",
		);

		if (importStatusEl) {
			const importStatus = await getSyncStatus("import");
			if (importStatus.connected) {
				importStatusEl.innerHTML = `
          <div style="width: 8px; height: 8px; border-radius: 50%; background: ${importStatus.hasPermission ? "var(--positive)" : "var(--warning)"};"></div>
          <span style="font-size: 12px; color: var(--text-primary); font-weight: 500;">${importStatus.name}</span>
          <span style="font-size: 11px; color: var(--text-muted);">${importStatus.hasPermission ? "Connected" : "Needs permission"}</span>
        `;
				importConnectBtn?.classList.add("hidden");
				importDisconnectBtn?.classList.remove("hidden");
			} else {
				importStatusEl.innerHTML = `
          <div style="width: 8px; height: 8px; border-radius: 50%; background: var(--text-placeholder);"></div>
          <span style="font-size: 12px; color: var(--text-muted);">Not connected</span>
        `;
				importConnectBtn?.classList.remove("hidden");
				importDisconnectBtn?.classList.add("hidden");
			}
		}
	}

	await updateSyncStatusUI();

	/* Connect export folder */
	document
		.getElementById("sync-export-connect")
		?.addEventListener("click", async () => {
			const result = await connectSyncFolder("export");
			if (result.success) {
				/* Backfill all historical weeks on first connection */
				const { autoExportAllWeeks } = await import("./sync.js");
				const count = await autoExportAllWeeks(appState);
				if (count > 0) {
					console.log(`Backfilled ${count} weeks to sync folder`);
				}
				await updateSyncStatusUI();
			} else if (result.error) {
				console.warn("Export folder connection failed:", result.error);
			}
		});

	/* Disconnect export folder */
	document
		.getElementById("sync-export-disconnect")
		?.addEventListener("click", async () => {
			await disconnectSyncFolder("export");
			await updateSyncStatusUI();
		});

	/* Connect import folder */
	document
		.getElementById("sync-import-connect")
		?.addEventListener("click", async () => {
			const result = await connectSyncFolder("import");
			if (result.success) {
				await updateSyncStatusUI();
			} else if (result.error) {
				console.warn("Import folder connection failed:", result.error);
			}
		});

	/* Disconnect import folder */
	document
		.getElementById("sync-import-disconnect")
		?.addEventListener("click", async () => {
			await disconnectSyncFolder("import");
			await updateSyncStatusUI();
		});
}
