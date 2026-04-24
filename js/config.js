/* ============================================================================
 * config.js — Chronos Application Configuration
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
  { id: 'meeting_internal',   label: 'Live Meeting — Internal',      color: 'blue',    hex: '#3B82F6' },
  { id: 'meeting_merchant',   label: 'Live Meeting — Merchant',      color: 'cyan',    hex: '#06B6D4' },
  { id: 'data_migration',     label: 'Data Migration / Cleaning',    color: 'violet',  hex: '#8B5CF6' },
  { id: 'admin',              label: 'Admin (Email/Slack)',           color: 'amber',   hex: '#F59E0B' },
  { id: 'analytics',          label: 'Analytics',                    color: 'pink',    hex: '#EC4899' },
  { id: 'research_sync',      label: 'Research / Product Sync',      color: 'lime',    hex: '#84CC16' },
  { id: 'internal_tools',     label: 'Internal Tools',               color: 'emerald',  hex: '#10B981' },
  { id: 'api_scoping',        label: 'API / Technical Scoping',      color: 'orange',  hex: '#F97316' },
  { id: 'hardware',           label: 'Hardware',                     color: 'red',     hex: '#EF4444' },
  { id: 'zendesk_admin',      label: 'Zendesk / Email / Slack Admin', color: 'yellow', hex: '#EAB308' },
  { id: 'lunch',              label: 'Lunch',                        color: 'gray',    hex: '#9CA3AF' },
  { id: 'other',              label: 'Other',                        color: 'slate',   hex: '#64748B' },
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
  meeting_internal:   2,
  meeting_merchant:   1,
  data_migration:     1,
  admin:              2,
  analytics:          2,
  research_sync:      2,
  internal_tools:     2,
  api_scoping:        1,
  hardware:           1,
  zendesk_admin:      2,
  lunch:              3,
  other:              3,
};

/* ----------------------------------------------------------------------------
 * TIER DEFINITIONS
 * --------------------------------------------------------------------------
 * Display metadata for each tier level.
 * ------------------------------------------------------------------------- */
export const TIERS = {
  1: { label: 'Tier 1', description: 'Customer-facing',      hex: '#8B5CF6', bg: '#EDE9FE' },
  2: { label: 'Tier 2', description: 'Internal job duties',  hex: '#10B981', bg: '#D1FAE5' },
  3: { label: 'Tier 3', description: 'Other',                hex: '#9CA3AF', bg: '#F3F4F6' },
};

/* ----------------------------------------------------------------------------
 * BILLABLE SCOPE OPTIONS
 * --------------------------------------------------------------------------
 * The defined list of work that qualifies as "billable" under the
 * optimization scope. Displayed as reference in the UI — the actual
 * billable flag is a simple checkbox on each time entry.
 * ------------------------------------------------------------------------- */
export const BILLABLE_SCOPE = {
  included: [
    'In-depth troubleshooting of supported products/hardware (excl. accounting)',
    'API troubleshooting / consultation',
    'Account cleanups / consolidation consultation and support',
    'Strategic growth consultation',
    'Account usage consults to remove roadblocks',
    'Import formatting consultation / limited support',
    'Analytics',
  ],
  excluded: [
    'Custom tool / template development',
    'Unsupported products / hardware',
    'Onboarding / implementation',
    'Requests/issues requiring ongoing support that regular flow teams cannot address',
  ],
};

/* ----------------------------------------------------------------------------
 * TIME GRID SETTINGS
 * --------------------------------------------------------------------------
 * Defaults for the daily time grid. Users can override start/end times
 * and lunch time in their personal settings.
 * ------------------------------------------------------------------------- */
export const TIME_DEFAULTS = {
  dayStartHour: 8,       // 8:00 AM
  dayEndHour: 17,        // 5:00 PM (last block starts at 16:30)
  blockMinutes: 30,      // Each block is 30 minutes
  lunchStartHour: 12,    // Default lunch at 12:00 PM
  lunchBlocks: 2,        // 1 hour lunch = 2 blocks
};

/* ----------------------------------------------------------------------------
 * TRACKING TARGETS
 * --------------------------------------------------------------------------
 * Compliance thresholds used in dashboards and alerts.
 * ------------------------------------------------------------------------- */
export const TARGETS = {
  dailyTrackableHours: 7,       // 8 hrs minus 1 hr lunch
  weeklyTrackableHours: 35,     // 7 hrs × 5 days
  compliancePercent: 60,        // Minimum tracked % target
  fiscalYearStartMonth: 4,     // April (1-indexed)
  fiscalYearStartDay: 1,
};

/* ----------------------------------------------------------------------------
 * DEFAULT USER SETTINGS
 * --------------------------------------------------------------------------
 * Initial settings for a new user. Persisted in IndexedDB after first
 * modification.
 * ------------------------------------------------------------------------- */
export const DEFAULT_USER_SETTINGS = {
  name: '',
  role: 'contributor',            // 'contributor' or 'manager'
  dayStartHour: TIME_DEFAULTS.dayStartHour,
  dayEndHour: TIME_DEFAULTS.dayEndHour,
  lunchStartHour: TIME_DEFAULTS.lunchStartHour,
  lunchBlocks: TIME_DEFAULTS.lunchBlocks,
  enableMerchant: false,
  enableFormerPOS: false,
  backupFolderHandle: null,       // File System Access API handle
  backupFrequency: 'daily',      // 'daily' or 'weekly'
  lastBackupDate: null,
};

/* ----------------------------------------------------------------------------
 * APP VIEWS
 * --------------------------------------------------------------------------
 * Identifiers for the main views/screens in the app.
 * ------------------------------------------------------------------------- */
export const VIEWS = {
  TRACKER: 'tracker',
  STATS: 'stats',
  MANAGER: 'manager',
  SETTINGS: 'settings',
};

/* ----------------------------------------------------------------------------
 * OUTLIER DETECTION
 * --------------------------------------------------------------------------
 * Configuration for the statistical outlier detection used in dashboards.
 * ------------------------------------------------------------------------- */
export const OUTLIER_CONFIG = {
  stdDevThreshold: 1.5,    // Flag if > 1.5 std deviations from mean
  minWeeksForTrend: 4,     // Need at least 4 weeks of data for trend analysis
};
