import assert from "node:assert/strict";

class MockTable {
	constructor(name, db) {
		this.name = name;
		this.db = db;
		this.data = [];
	}

	async put(item) {
		const key = item.key ?? item.date ?? item.weekKey ?? item.id;
		const existingIndex = this.data.findIndex((entry) => {
			if (entry.key !== undefined && entry.key === key) return true;
			if (entry.date !== undefined && entry.date === key) return true;
			if (entry.weekKey !== undefined && entry.weekKey === key) return true;
			return false;
		});

		if (existingIndex >= 0) {
			this.data[existingIndex] = item;
		} else {
			this.data.push(item);
		}
	}

	async add(item) {
		await this.put(item);
	}

	async bulkAdd(items) {
		for (const item of items) {
			await this.put(item);
		}
	}

	async clear() {
		this.data = [];
	}

	async get(key) {
		return this.data.find((entry) => {
			if (entry.key !== undefined && entry.key === key) return true;
			if (entry.date !== undefined && entry.date === key) return true;
			if (entry.weekKey !== undefined && entry.weekKey === key) return true;
			return false;
		});
	}

	async count() {
		return this.data.length;
	}

	async toArray() {
		return this.data.slice();
	}

	where(index) {
		return new MockWhereClause(this, index);
	}

	async orderBy(index) {
		return new MockOrderClause(this, index);
	}
}

class MockWhereClause {
	constructor(table, index) {
		this.table = table;
		this.index = index;
		this._equalsValue = undefined;
		this._between = undefined;
		this._sortField = undefined;
	}

	equals(value) {
		this._equalsValue = value;
		return this;
	}

	between(start, end) {
		this._between = [start, end];
		return this;
	}

	sortBy(field) {
		this._sortField = field;
		return this.toArray();
	}

	async first() {
		const rows = await this.toArray();
		return rows[0];
	}

	async toArray() {
		let rows = this.table.data.filter((entry) => {
			if (this._equalsValue !== undefined) {
				if (this.index === "[date+timeSlot]") {
					const [date, timeSlot] = this._equalsValue;
					return entry.date === date && entry.timeSlot === timeSlot;
				}
				if (entry[this.index] !== undefined) {
					return entry[this.index] === this._equalsValue;
				}
				return entry.key === this._equalsValue;
			}

			if (this._between) {
				const [start, end] = this._between;
				if (this.index === "date" && entry.date !== undefined) {
					return entry.date >= start && entry.date <= end;
				}
			}

			return true;
		});

		if (this._sortField) {
			rows = rows.slice().sort((a, b) => {
				const left = a[this._sortField] ?? "";
				const right = b[this._sortField] ?? "";
				return String(left).localeCompare(String(right));
			});
		}

		return rows;
	}
}

class MockOrderClause {
	constructor(table, index) {
		this.table = table;
		this.index = index;
		this.reverseFlag = false;
		this.limitCount = undefined;
	}

	reverse() {
		this.reverseFlag = true;
		return this;
	}

	limit(count) {
		this.limitCount = count;
		return this;
	}

	async toArray() {
		let rows = this.table.data.slice();
		if (this.index) {
			rows = rows.slice().sort((a, b) => {
				const left = a[this.index] ?? "";
				const right = b[this.index] ?? "";
				return String(left).localeCompare(String(right));
			});
		}
		if (this.reverseFlag) {
			rows.reverse();
		}
		if (this.limitCount !== undefined) {
			rows = rows.slice(0, this.limitCount);
		}
		return rows;
	}

	async first() {
		const rows = await this.toArray();
		return rows[0];
	}

	async uniqueKeys() {
		return [
			...new Set(
				this.table.data.map((entry) => entry[this.index]).filter(Boolean),
			),
		];
	}
}

class MockDexie {
	constructor(name) {
		this.name = name;
		this.tables = new Map();
	}

	version() {
		return {
			stores: (schema) => {
				for (const [name] of Object.entries(schema)) {
					if (!this.tables.has(name)) {
						this[name] = new MockTable(name, this);
						this.tables.set(name, this[name]);
					}
				}
			},
		};
	}

	async transaction(mode, tables, callback) {
		return callback();
	}
}

globalThis.Dexie = MockDexie;

const {
	restoreFromPersonalBackup,
	getUserSettings,
	getTierMap,
	getEntriesForDateRange,
	getWeeklyNotes,
	getTicketStats,
	getDayMeta,
	db,
} = await import("./js/db.js");

async function resetDb() {
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
			await db.entries.clear();
			await db.settings.clear();
			await db.tierMap.clear();
			await db.weeklyNotes.clear();
			await db.ticketStats.clear();
			await db.dayMeta.clear();
		},
	);
}

await resetDb();

const backupData = {
	contributor: { name: "Ada Lovelace", role: "manager" },
	settings: {
		name: "Ada Lovelace",
		role: "manager",
		hiddenCategories: ["lunch"],
	},
	tierMap: { analytics: 2, other: 3 },
	weeks: [
		{
			weekKey: "2026-W30",
			entries: [
				{
					date: "2026-07-20",
					timeSlot: "09:00",
					category: "analytics",
					merchant: "Acme",
				},
			],
			weeklyNotes: {
				wins: "ship",
				losses: "",
				issues: "",
				customerMeetings: "1",
			},
			ticketStats: [
				{ date: "2026-07-20", queueSize: 5, newTickets: 2, closedTickets: 1 },
			],
			dayMeta: [{ date: "2026-07-20", onQueue: true }],
		},
	],
};

await restoreFromPersonalBackup(backupData);

const settings = await getUserSettings();
const tierMap = await getTierMap();
const entries = await getEntriesForDateRange("2026-07-20", "2026-07-20");
const notes = await getWeeklyNotes("2026-W30");
const stats = await getTicketStats("2026-07-20");
const meta = await getDayMeta("2026-07-20");

console.log({ settings, tierMap, entries, notes, stats, meta });

assert.equal(settings.name, "Ada Lovelace");
assert.equal(settings.role, "manager");
assert.equal(settings.hiddenCategories[0], "lunch");
assert.equal(tierMap.analytics, 2);
assert.equal(tierMap.other, 3);
assert.equal(entries.length, 1);
assert.equal(entries[0].merchant, "Acme");
assert.equal(notes.wins, "ship");
assert.equal(stats.queueSize, 5);
assert.equal(stats.newTickets, 2);
assert.equal(stats.closedTickets, 1);
assert.equal(meta.onQueue, true);

console.log("sync restore regression test passed");
