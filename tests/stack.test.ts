import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureSpeaches, ensureSpeechModel, ensureStack } from '../src/stack.js';
import { fromToml } from '../src/config.js';
import type { Shell } from '../src/stack.js';

/** A Speaches that only exists once "docker run" was said — the port is reserved first, then listened on. */
let server: Server | null = null;
const installed = new Set<string>();

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
	const port = (probe.address() as { port: number }).port;
	await new Promise<void>((r) => probe.close(() => r()));
	return port;
}

function listen(port: number): Promise<void> {
	server = createServer((req, res) => {
		if (req.url === '/v1/models' && req.method === 'GET') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ data: [...installed].map((id) => ({ id })) }));
		}
		if (req.url?.startsWith('/v1/models/') && req.method === 'POST') {
			installed.add(decodeURIComponent(req.url.slice('/v1/models/'.length)));
			res.writeHead(201);
			return res.end();
		}
		res.writeHead(200);
		res.end('ok');
	});
	return new Promise((r) => server!.listen(port, '127.0.0.1', r));
}

afterEach(() => {
	server?.close();
	server = null;
	installed.clear();
});

function shell(port: number, over: Partial<Shell> = {}): Shell & { ran: string[]; said: string[] } {
	const ran: string[] = [];
	const said: string[] = [];
	return {
		ran,
		said,
		run: async (line) => {
			ran.push(line);
			if (line.startsWith('docker run') || line.startsWith('docker start')) await listen(port);
			return true;
		},
		capture: async () => '',
		has: (cmd) => cmd === 'docker',
		say: (line) => void said.push(line),
		sleep: async () => {},
		...over
	};
}

describe('the stack', () => {
	it('starts a Speaches on the port the config names, then downloads its model', async () => {
		const port = await freePort();
		const sh = shell(port);
		expect(await ensureSpeaches(`http://127.0.0.1:${port}`, 'speaches', sh)).toBe(true);
		expect(sh.ran[0]).toBe(
			`docker run -d --name speaches --restart unless-stopped -p ${port}:8000 ghcr.io/speaches-ai/speaches:latest-cpu`
		);
		expect(await ensureSpeechModel('ears', `http://127.0.0.1:${port}`, 'Systran/faster-whisper-small', sh)).toBe(true);
		expect(installed.has('Systran/faster-whisper-small')).toBe(true);
		expect(sh.said.at(-1)).toMatch(/✓ ears: Systran\/faster-whisper-small at/);
	});

	it('leaves a Speaches that already answers alone', async () => {
		const port = await freePort();
		await listen(port);
		const sh = shell(port);
		expect(await ensureSpeaches(`http://127.0.0.1:${port}`, 'speaches', sh)).toBe(true);
		expect(sh.ran).toEqual([]);
	});

	it('starts a stopped container again rather than making a second one', async () => {
		const port = await freePort();
		const sh = shell(port, { capture: async (line) => (line.includes('ps -a') ? 'speaches-voice\n' : '') });
		expect(await ensureSpeaches(`http://127.0.0.1:${port}`, 'speaches-voice', sh)).toBe(true);
		expect(sh.ran[0]).toBe('docker start speaches-voice');
	});

	it('without docker says so and does not pretend', async () => {
		const port = await freePort();
		const sh = shell(port, { has: () => false });
		expect(await ensureSpeaches(`http://127.0.0.1:${port}`, 'speaches', sh)).toBe(false);
		expect(sh.said.join('\n')).toMatch(/docker is not here/);
	});

	it('one server for both halves is started once', async () => {
		const port = await freePort();
		const sh = shell(port);
		const c = fromToml(
			`[ontoplano]\ntoken="t"\n[llm]\nurl="http://127.0.0.1:1/v1"\n[stt]\nurl="127.0.0.1:${port}"\n[tts]\nkind="openai"\nurl="127.0.0.1:${port}"\nmodel="k"\nvoice="v"`,
			{ HOME: '/x' } as NodeJS.ProcessEnv
		);
		await ensureStack(c, sh);
		expect(sh.ran.filter((l) => l.startsWith('docker run'))).toHaveLength(1);
		expect(installed.has('k')).toBe(true);
	});
});
