/* ============================================================================
 * config.js — Pulse Application Configuration
 * ============================================================================
 * Central source of truth for all app constants, work categories, tier
 * mappings, and default settings. Tier mappings can be modified by managers
 * at runtime and are persisted in IndexedDB.
 * ========================================================================= */

/* ----------------------------------------------------------------------------
 * WORK CATEGORIES
 * --------------------------------------------------------------------------
 * The standardized list of time block categories available to all users.
 * Each category has:
 *   - id:    Unique key used in data storage
 *   - label: Display name shown in dropdowns and charts
 *   - color: Tailwind-compatible color used for block accents and charts
 *   - hex:   Hex color value for Chart.js and inline styles
 * ------------------------------------------------------------------------- */
export const CATEGORIES = [
	{
		id: "admin_internal",
		label: "Admin — Internal",
		help: "Email and Slack that is not customer-related",
		color: "corn field",
		hex: "#f0edc1",
		cssVar: "--cat-admin-internal-border",
	},
	{
		id: "admin_merchant",
		label: "Admin — Merchant",
		help: "Queue work, short ticket handling, replying to customers",
		color: "soft lemon",
		hex: "#f0edc1",
		cssVar: "--cat-admin-merchant-border",
	},
	{
		id: "analytics",
		label: "Analytics Support",
		help: "Troubleshooting or building custom Analytics reports",
		color: "bright nude",
		hex: "#f2d1b0",
		cssVar: "--cat-analytics-border",
	},
	{
		id: "api_scoping",
		label: "API / Technical Scoping",
		help: "Consulting or troubleshooting Lightspeed's API",
		color: "eva",
		hex: "#f1c5cd",
		cssVar: "--cat-api-border",
	},
	{
		id: "data_migration",
		label: "Data Migration / Cleaning",
		help: "Transforming merchant data, cleaning CSV files, imports",
		color: "boomerang lilac",
		hex: "#f1c5e6",
		cssVar: "--cat-migration-border",
	},
	{
		id: "hardware",
		label: "Hardware Support",
		help: "Troubleshooting or training customers on hardware",
		color: "perfume",
		hex: "#e1c5f1",
		cssVar: "--cat-hardware-border",
	},
	{
		id: "meeting_internal",
		label: "Live Meeting — Internal",
		help: "Internal team meeting",
		color: "arctic blue",
		hex: "#ced2f3",
		cssVar: "--cat-meeting-int-border",
	},
	{
		id: "meeting_merchant",
		label: "Live Meeting — Merchant",
		help: "Live meeting with a merchant",
		color: "aqua inlet",
		hex: "#8992e6",
		cssVar: "--cat-meeting-merch-border",
	},
	{
		id: "onboarding",
		label: "Onboarding Support",
		help: "Helping SICs get merchants started with Lightspeed",
		color: "cool aqua",
		hex: "#c5f1ee",
		cssVar: "--cat-onboarding-border",
		legacy: true,
	},
	{
		id: "research_sync",
		label: "Research / Product Sync",
		help: "Jira creation or in-depth research not related to troubleshooting",
		color: "ariella",
		hex: "#c5f1ee",
		cssVar: "--cat-research-border",
	},
	{
		id: "internal_tools",
		label: "Tools Dev — Internal",
		help: "Building team tools",
		color: "ocean breeze",
		hex: "#c5eed2",
		cssVar: "--cat-tools-border",
	},
	{
		id: "external_tools",
		label: "Tools Dev — Merchant",
		help: "Building merchant-facing tools",
		color: "cool aqua",
		hex: "#2dd264",
		cssVar: "--cat-external-tools-border",
	},
	{
		id: "troubleshooting",
		label: "Troubleshooting",
		help: "Diagnosing and fixing issues not covered by other categories",
		color: "light pastel mint",
		hex: "#ddf0c1",
		cssVar: "--cat-troubleshooting-border",
	},
	{
		id: "lunch",
		label: "Lunch",
		color: "gray",
		hex: "#C8C4C0",
		cssVar: "--cat-lunch-border",
	},
	{
		id: "ooo",
		label: "OOO",
		color: "slate",
		hex: "#B0B8C0",
		cssVar: "--cat-ooo-border",
	},
	{
		id: "other",
		label: "Other",
		help: "Work that doesn't fit any other category",
		color: "stone",
		hex: "#A8A8A8",
		cssVar: "--cat-other-border",
	},
];

/* ----------------------------------------------------------------------------
 * DEFAULT TIER MAPPINGS
 * --------------------------------------------------------------------------
 * Maps each category ID to a tier. This is the default configuration;
 * managers can override these at runtime. Changes persist in IndexedDB.
 *
 * Tier 1 = Directly customer-facing work
 * Tier 2 = Internal job duties (not directly customer-facing)
 * Tier 3 = Everything else (lunch, misc)
 * ------------------------------------------------------------------------- */
export const DEFAULT_TIER_MAP = {
	meeting_internal: 2,
	meeting_merchant: 1,
	data_migration: 1,
	admin_internal: 2,
	admin_merchant: 1,
	analytics: 1,
	research_sync: 2,
	troubleshooting: 1,
	internal_tools: 2,
	external_tools: 1,
	api_scoping: 1,
	hardware: 1,
	lunch: null,
	ooo: null,
	other: 3,
};

/* ----------------------------------------------------------------------------
 * TIER DEFINITIONS
 * --------------------------------------------------------------------------
 * Display metadata for each tier level.
 * ------------------------------------------------------------------------- */
export const TIERS = {
	1: {
		label: "Tier 1",
		description: "Customer-facing",
		hex: "#7c3aed",
		bg: "#EDE9FE",
		hexVar: "--accent-hover",
		bgVar: "--accent-light",
	},
	2: {
		label: "Tier 2",
		description: "Internal job duties",
		hex: "#10b981",
		bg: "#D1FAE5",
		hexVar: "--positive",
		bgVar: "--positive-light",
	},
	3: {
		label: "Tier 3",
		description: "Other",
		hex: "#9CA3AF",
		bg: "#F3F4F6",
		hexVar: "--text-muted",
		bgVar: "--bg-surface",
	},
};

/* ----------------------------------------------------------------------------
 * TIME GRID SETTINGS
 * --------------------------------------------------------------------------
 * Defaults for the daily time grid. Users can override start/end times
 * and lunch time in their personal settings.
 * ------------------------------------------------------------------------- */
export const TIME_DEFAULTS = {
	dayStartHour: 8, // 8:00 AM
	dayEndHour: 17, // 5:00 PM (last block starts at 16:30)
	blockMinutes: 30, // Each block is 30 minutes
	lunchStartHour: 12, // Default lunch at 12:00 PM
	lunchBlocks: 2, // 1 hour lunch = 2 blocks
};

/* ----------------------------------------------------------------------------
 * TRACKING TARGETS
 * --------------------------------------------------------------------------
 * Compliance thresholds used in dashboards and alerts.
 * ------------------------------------------------------------------------- */
export const TARGETS = {
	dailyTrackableHours: 8, // Full 8-hour day including lunch
	weeklyTrackableHours: 40, // 8 hrs × 5 days
	compliancePercent: 60,
	fiscalYearStartMonth: 4,
	fiscalYearStartDay: 1,
};

/* ----------------------------------------------------------------------------
 * DEFAULT USER SETTINGS
 * --------------------------------------------------------------------------
 * Initial settings for a new user. Persisted in IndexedDB after first
 * modification.
 * ------------------------------------------------------------------------- */
export const DEFAULT_USER_SETTINGS = {
	name: "",
	role: "contributor", // 'contributor' or 'manager'
	dayStartHour: TIME_DEFAULTS.dayStartHour,
	dayEndHour: TIME_DEFAULTS.dayEndHour,
	lunchStartHour: TIME_DEFAULTS.lunchStartHour,
	lunchBlocks: TIME_DEFAULTS.lunchBlocks,
	enableMerchant: false,
	enableFormerPOS: false,
	hiddenCategories: [],
	backupFolderHandle: null, // File System Access API handle
	backupFrequency: "daily", // 'daily' or 'weekly'
	lastBackupDate: null,
};

/* ----------------------------------------------------------------------------
 * APP VIEWS
 * --------------------------------------------------------------------------
 * Identifiers for the main views/screens in the app.
 * ------------------------------------------------------------------------- */
export const VIEWS = {
	TRACKER: "tracker",
	STATS: "stats",
	MANAGER: "manager",
	SETTINGS: "settings",
};

/* ----------------------------------------------------------------------------
 * OUTLIER DETECTION
 * --------------------------------------------------------------------------
 * Configuration for the statistical outlier detection used in dashboards.
 * ------------------------------------------------------------------------- */
export const OUTLIER_CONFIG = {
	stdDevThreshold: 1.5, // Flag if > 1.5 std deviations from mean
	minWeeksForTrend: 4, // Need at least 4 weeks of data for trend analysis
};

/* Manager access control */
export const MANAGER_NAMES = ["reid", "onnela", "fleurien"];
export const MANAGER_HASH =
	"ca0f791514c0bea1d3b835e9b40c1d4f8c85df8562684e36ddbd68eb8d7384a4";
