/* ============================================================================
 * theme.js — Theme Management
 * ============================================================================
 * Handles light/dark mode switching:
 *   - Detects system preference on first load
 *   - Saves preference to localStorage
 *   - Toggles data-theme attribute on <html>
 *   - Exposes current theme for Chart.js color adaptation
 * ========================================================================= */

/**
 * initTheme
 * Called once on page load. Sets the initial theme based on:
 * 1. Previously saved preference in localStorage
 * 2. System prefers-color-scheme
 * 3. Falls back to 'light'
 */
export function initTheme() {
	const saved = localStorage.getItem("chronos-theme");

	if (saved) {
		applyTheme(saved);
	} else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
		applyTheme("dark");
	} else {
		applyTheme("light");
	}

	/* Listen for system preference changes (e.g., OS switches to night mode) */
	window
		.matchMedia("(prefers-color-scheme: dark)")
		.addEventListener("change", (e) => {
			/* Only auto-switch if user hasn't manually set a preference */
			if (!localStorage.getItem("chronos-theme")) {
				applyTheme(e.matches ? "dark" : "light");
			}
		});
}

/**
 * applyTheme
 * Sets the data-theme attribute on <html> and updates the toggle icon.
 *
 * @param {string} theme - 'light' or 'dark'
 */
export function applyTheme(theme) {
	document.documentElement.setAttribute("data-theme", theme);
	updateToggleIcon(theme);
}

/**
 * toggleTheme
 * Switches between light and dark mode. Saves the preference.
 */
export function toggleTheme() {
	const current =
		document.documentElement.getAttribute("data-theme") || "light";
	const next = current === "dark" ? "light" : "dark";
	applyTheme(next);
	localStorage.setItem("chronos-theme", next);
}

/**
 * getTheme
 * Returns the current theme string.
 *
 * @returns {string} 'light' or 'dark'
 */
export function getTheme() {
	return document.documentElement.getAttribute("data-theme") || "light";
}

/**
 * isDark
 * Convenience check for dark mode.
 *
 * @returns {boolean}
 */
export function isDark() {
	return getTheme() === "dark";
}

/**
 * updateToggleIcon
 * Swaps the sun/moon SVG in the theme toggle button.
 *
 * @param {string} theme - Current theme
 */
function updateToggleIcon(theme) {
	const btn = document.getElementById("theme-toggle");
	if (!btn) return;

	if (theme === "dark") {
		/* Moon icon */
		btn.innerHTML = `
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round"
              d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 006.002-2.082z" />
      </svg>
    `;
	} else {
		/* Sun icon */
		btn.innerHTML = `
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round"
              d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
      </svg>
    `;
	}
}

/**
 * getChartColors
 * Returns a color set adapted for the current theme.
 * Used by stats.js and manager.js when rendering Chart.js charts.
 *
 * @returns {Object} Color values for chart rendering
 */
export function getChartColors() {
	if (isDark()) {
		return {
			gridColor: "#2A2730",
			tickColor: "#6B6580",
			tooltipBg: "#1E1C24",
			tooltipBorder: "#2A2730",
			tooltipText: "#E8E4ED",
			legendColor: "#9590A0",
			emptyText: "#6B6580",
			/* Category colors — vibrant for dark backgrounds */
			categories: {
				admin_internal: "#d9d163",
				admin_merchant: "#e0d45c",
				analytics: "#e49e59",
				api_scoping: "#d96378",
				data_migration: "#d963bc",
				hardware: "#ae63d9",
				meeting_internal: "#6f7adc",
				meeting_merchant: "#1f31d6",
				onboarding: "#63d9d1",
				research_sync: "#63d9d1",
				internal_tools: "#63d97d",
				external_tools: "#1dc942",
				troubleshooting: "#a8d963",
				lunch: "#8A8490",
				ooo: "#7A8CA3",
				other: "#847E8A",
			},
			/* Tier colors */
			tier1: { hex: "#B794F4", bg: "rgba(183,148,244,0.15)" },
			tier2: { hex: "#48DBB4", bg: "rgba(72,219,180,0.15)" },
			tier3: { hex: "#6B6580", bg: "rgba(107,101,128,0.15)" },
			/* Accent */
			accent: "#A78BFA",
			accentLight: "rgba(167,139,250,0.15)",
			positive: "#48DBB4",
			warning: "#F6AD55",
			danger: "#FC8181",
		};
	} else {
		return {
			gridColor: "#F0EDF3",
			tickColor: "#8A8490",
			tooltipBg: "#FFFFFF",
			tooltipBorder: "#E7E5E4",
			tooltipText: "#1C1917",
			legendColor: "#6B6560",
			emptyText: "#8A8490",
			/* Category colors — rich but not neon */
			categories: {
				admin_internal: "#e9e5a5",
				admin_merchant: "#dbd257",
				analytics: "#f2d1b0",
				api_scoping: "#f1c5cd",
				data_migration: "#f1c5e6",
				hardware: "#e1c5f1",
				meeting_internal: "#a5ace9",
				meeting_merchant: "#5764db",
				onboarding: "#c5f1ee",
				research_sync: "#c5f1ee",
				internal_tools: "#a5e9b4",
				external_tools: "#57db73",
				troubleshooting: "#ddf0c1",
				lunch: "#C8C4C0",
				ooo: "#B0B8C0",
				other: "#A8A8A8",
			},
			/* Tier colors */
			tier1: { hex: "#8B5CF6", bg: "#EDE9FE" },
			tier2: { hex: "#10B981", bg: "#D1FAE5" },
			tier3: { hex: "#9CA3AF", bg: "#F3F4F6" },
			/* Accent */
			accent: "#8B5CF6",
			accentLight: "#F5F3FF",
			positive: "#10B981",
			warning: "#F59E0B",
			danger: "#EF4444",
		};
	}
}
