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

function attachSettingsListeners() {
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
}
