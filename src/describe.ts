/*
 * What an action looks like on the phone: one line, and where it opens.
 *
 * The model's reply says what happened in its own words; this is the
 * receipt beside it — "add_task · #812 buy milk" with a link into the app —
 * so the person can check what was actually done without taking the
 * model's word for it. The link table mirrors the app's `$lib/object-links`.
 */
import type { ToolResult } from './mcp.js';

/** The room a tool's object opens in, by the tool's name. `edit` rooms take `?edit=<id>`. */
const ROOMS: { match: RegExp; room: string; edit: boolean }[] = [
	{ match: /_task$|^tasks$|_tasks$/, room: '/tasks/todo', edit: true },
	{ match: /_goal$|^goals$/, room: '/goals', edit: true },
	{ match: /^write_entry$|^edit_entry$|_note$|^diary$/, room: '/notebooks/diary', edit: true },
	{ match: /_notebook$|^notebooks$/, room: '/notebooks', edit: false },
	{ match: /_habit$|^habits$|^all_habits$/, room: '/health/habits', edit: true },
	{ match: /_idea$|^ideas$/, room: '/notebooks/ideas', edit: true },
	{ match: /_person$|^people$/, room: '/notebooks/people', edit: false },
	{
		match: /_inventory_item$|^tick_bought$|^untick_bought$|^shopping_list$|^where_is$|^put_item$/,
		room: '/inventory/stock',
		edit: true
	},
	{ match: /_recipe$|^recipes$/, room: '/health/recipes', edit: true },
	{ match: /_workout|^workouts$/, room: '/health/workouts', edit: false },
	{ match: /_bill$|^bills|^month_bills$/, room: '/finance/bills', edit: true },
	{ match: /_movement$|^movements$|_ledger$|^ledgers$/, room: '/finance/ledgers', edit: false },
	{ match: /_block$|^upcoming$|^today$|^repeating_week$/, room: '/tasks/plan', edit: false },
	{ match: /alarm$|reminder$|^reminders$|^remind_/, room: '/reminders', edit: false },
	{ match: /_win$|^daily_wins$/, room: '/', edit: false }
];

type Obj = { id?: unknown; seq?: unknown; notebookSeq?: unknown; title?: unknown; name?: unknown };

/** The object a result is about: the `after` of a change, the thing itself, or nothing. */
function objectOf(structured: unknown): Obj | null {
	if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return null;
	const s = structured as { after?: unknown; task?: unknown; note?: unknown };
	for (const candidate of [s.after, s.task, s.note, structured]) {
		if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
			const o = candidate as Obj;
			if (o.id !== undefined || o.title !== undefined || o.name !== undefined) return o;
		}
	}
	return null;
}

export type Receipt = { summary: string; link: string | null };

export function describeAction(
	appUrl: string,
	name: string,
	args: Record<string, unknown>,
	result: ToolResult
): Receipt {
	const verb = name.replace(/_/g, ' ');
	if (!result.ok) return { summary: `${verb}: ${firstLine(result.text) || 'refused'}`, link: null };
	const obj = objectOf(result.structured);
	const title = typeof obj?.title === 'string' ? obj.title : typeof obj?.name === 'string' ? obj.name : '';
	const seq = typeof obj?.notebookSeq === 'number' ? obj.notebookSeq : typeof obj?.seq === 'number' ? obj.seq : null;
	const count = countOf(result.structured);
	let summary = verb;
	if (seq !== null && title) summary = `${verb} · #${seq} ${title}`;
	else if (title) summary = `${verb} · ${title}`;
	else if (count !== null) summary = `${verb} · ${count}`;
	else {
		const said = Object.values(args).find((v) => typeof v === 'string' && v.length < 80);
		if (typeof said === 'string') summary = `${verb} · ${said}`;
	}
	return { summary, link: linkFor(appUrl, name, obj) };
}

function countOf(structured: unknown): number | null {
	if (!structured || typeof structured !== 'object') return null;
	const s = structured as { count?: unknown; items?: unknown; total?: unknown };
	if (typeof s.count === 'number') return s.count;
	if (Array.isArray(s.items)) return s.items.length;
	return null;
}

export function linkFor(appUrl: string, tool: string, obj: Obj | null): string | null {
	const room = ROOMS.find((r) => r.match.test(tool));
	if (!room) return null;
	const id = obj && (typeof obj.id === 'number' || typeof obj.id === 'string') ? obj.id : null;
	if (room.edit && id !== null) return `${appUrl}${room.room}?edit=${encodeURIComponent(String(id))}`;
	if (room.room === '/notebooks' && id !== null) return `${appUrl}/notebooks/${encodeURIComponent(String(id))}`;
	return `${appUrl}${room.room}`;
}

const firstLine = (t: string): string => t.split('\n')[0]?.slice(0, 160) ?? '';

/** The question a confirmation asks, from the call itself. */
export function confirmQuestion(name: string, args: Record<string, unknown>): string {
	const verb = name.replace(/_/g, ' ');
	const named = Object.entries(args)
		.filter(([, v]) => typeof v === 'string' || typeof v === 'number')
		.map(([k, v]) => `${k} ${String(v)}`)
		.slice(0, 3)
		.join(', ');
	return named ? `${verb} (${named})?` : `${verb}?`;
}
