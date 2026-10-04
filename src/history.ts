/*
 * What was said and done, kept: one line per turn in `turns.jsonl`.
 *
 * This is the audit log and the phone's history screen both. Everything a
 * tool did is here with its arguments and whether it succeeded, so "what did
 * it change on Tuesday" has an answer that is not the model's memory.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HISTORY_PAGE } from './constants.js';

export type ActionRecord = {
	name: string;
	args: Record<string, unknown>;
	ok: boolean;
	summary: string;
	link: string | null;
};

export type TurnRecord = {
	at: string;
	device: string;
	/** What the person said — typed, or as transcribed. */
	heard: string;
	reply: string;
	actions: ActionRecord[];
	/** A confirmation the turn stopped at, if it did. */
	asked?: string;
	error?: string;
};

const FILE = 'turns.jsonl';

export class History {
	private readonly path: string;

	constructor(dataDir: string) {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		this.path = join(dataDir, FILE);
	}

	append(record: TurnRecord): void {
		appendFileSync(this.path, JSON.stringify(record) + '\n', { mode: 0o600 });
	}

	/** The latest turns of one device, newest first. */
	recent(device: string, limit: number = HISTORY_PAGE): TurnRecord[] {
		if (!existsSync(this.path)) return [];
		const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
		const out: TurnRecord[] = [];
		for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
			try {
				const r = JSON.parse(lines[i] as string) as TurnRecord;
				if (r.device === device) out.push(r);
			} catch {
				// a torn line at the end of a file is not a reason to lose the rest
			}
		}
		return out;
	}
}
