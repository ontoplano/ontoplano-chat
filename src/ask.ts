/*
 * Questions on a terminal: a line, a choice from a list, a yes or no, a
 * secret typed without echo. The wizard takes this as an interface so a
 * test can answer from a script.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export type Option = { key: string; label: string; note?: string };

export type Ask = {
	text(question: string, fallback?: string): Promise<string>;
	secret(question: string): Promise<string>;
	choose(question: string, options: Option[], fallback: string): Promise<string>;
	yes(question: string, fallback: boolean): Promise<boolean>;
	say(line?: string): void;
};

/** Output that can be muted while a secret is typed. */
class Muted extends Writable {
	muted = false;
	constructor(private readonly out: NodeJS.WritableStream) {
		super();
	}
	override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
		if (!this.muted) this.out.write(chunk);
		cb();
	}
}

export function terminalAsk(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout
): Ask {
	const muted = new Muted(output);
	const rl = createInterface({ input, output: muted, terminal: true });
	// Lines are kept until a question wants one: answers typed ahead — or piped
	// in — are not lost while a check runs between two questions. Once the
	// input ends, every later question gets its default.
	const queue: string[] = [];
	let waiting: ((line: string) => void) | null = null;
	let closed = false;
	rl.on('line', (line) => {
		if (waiting) {
			const w = waiting;
			waiting = null;
			w(line);
		} else queue.push(line);
	});
	rl.on('close', () => {
		closed = true;
		if (waiting) {
			const w = waiting;
			waiting = null;
			w('');
		}
	});
	const question = (q: string, secret = false): Promise<string> => {
		if (secret) {
			output.write(q);
			muted.muted = true;
		} else {
			rl.setPrompt(q);
			rl.prompt();
		}
		const done = (line: string): string => {
			if (secret) {
				muted.muted = false;
				output.write('\n');
			}
			return line;
		};
		if (queue.length) return Promise.resolve(done(queue.shift() as string));
		if (closed) return Promise.resolve(done(''));
		return new Promise((resolve) => (waiting = (line) => resolve(done(line))));
	};
	const say = (line = ''): void => void output.write(line + '\n');
	return {
		say,
		async text(q, fallback = '') {
			const a = (await question(fallback ? `${q} [${fallback}] ` : `${q} `)).trim();
			return a || fallback;
		},
		async secret(q) {
			return (await question(`${q} `, true)).trim();
		},
		async choose(q, options, fallback) {
			say(q);
			options.forEach((o, i) => {
				say(`  ${i + 1}. ${o.label}${o.key === fallback ? '  (default)' : ''}`);
				if (o.note) say(`     ${o.note}`);
			});
			for (;;) {
				const a = (await question('> ')).trim();
				if (!a) return fallback;
				const n = Number(a);
				const byNumber = Number.isInteger(n) ? options[n - 1] : undefined;
				const byKey = options.find((o) => o.key === a);
				const hit = byNumber ?? byKey;
				if (hit) return hit.key;
				say(`  one of 1–${options.length}`);
				if (closed) return fallback;
			}
		},
		async yes(q, fallback) {
			const a = (await question(`${q} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
			if (!a) return fallback;
			return a === 'y' || a === 'yes' || a === 's' || a === 'sim';
		}
	};
}

/** Answers from a list, in order — for the tests. A missing answer is the default. */
export function scriptedAsk(answers: string[], log: string[] = []): Ask {
	const next = (): string | undefined => answers.shift();
	return {
		say: (line = '') => void log.push(line),
		async text(q, fallback = '') {
			log.push(q);
			const a = next();
			return a === undefined || a === '' ? fallback : a;
		},
		async secret(q) {
			log.push(q);
			return next() ?? '';
		},
		async choose(q, options, fallback) {
			log.push(q);
			const a = next();
			if (!a) return fallback;
			const n = Number(a);
			return (Number.isInteger(n) ? options[n - 1]?.key : options.find((o) => o.key === a)?.key) ?? fallback;
		},
		async yes(q, fallback) {
			log.push(q);
			const a = next();
			return a === undefined || a === '' ? fallback : a === 'y';
		}
	};
}
