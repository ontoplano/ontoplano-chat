import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fromToml } from '../src/config.js';
import { MAX_AUDIO_BYTES, PAIRING_RATE_LIMIT } from '../src/constants.js';
import { buildEngines } from '../src/engines.js';
import { History } from '../src/history.js';
import { Devices } from '../src/pairing.js';
import { createHttpServer, RateLimit } from '../src/server.js';
import { Assistant } from '../src/turn.js';

let dir: string;
let server: Server;
let url: string;
let devices: Devices;
let token: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'onto-server-'));
	const env = { HOME: dir, ONTOPLANO_CHAT_DATA: dir, ONTOPLANO_CHAT_ENGINES: 'fake' } as NodeJS.ProcessEnv;
	const config = fromToml(`[assistant]\nlanguage = "en"\n[ontoplano]\nurl = "https://app.example"`, env);
	const engines = buildEngines(config, env);
	await engines.tools.load();
	devices = new Devices(dir);
	const history = new History(dir);
	const assistant = new Assistant({
		name: 'Onto',
		language: 'en',
		appUrl: config.ontoplano.url,
		confirm: config.assistant.confirm,
		historyTurns: 4,
		maxToolRounds: 4,
		llm: engines.llm,
		stt: engines.stt,
		tts: engines.tts,
		mcp: engines.mcp,
		tools: () => engines.tools.current(),
		history
	});
	server = createHttpServer({ config, devices, assistant, history, engines, version: '0.0.0-test' });
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
	server.close();
	rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
	fetch(`${url}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)
	});
const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const lines = async (res: Response): Promise<{ type: string; [k: string]: unknown }[]> =>
	(await res.text())
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { type: string });

describe('the page', () => {
	it('is served with a strict CSP and no caching of the API', async () => {
		const res = await fetch(url + '/');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/html/);
		expect(res.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await res.text()).toContain('id="talk"');
	});

	it('serves only what is in web/', async () => {
		expect((await fetch(url + '/app.js')).status).toBe(200);
		expect((await fetch(url + '/../package.json')).status).toBe(404);
		expect((await fetch(url + '/%2e%2e/package.json')).status).toBe(404);
		expect((await fetch(url + '/src/cli.ts')).status).toBe(404);
	});

	it('writes the version into the service worker', async () => {
		expect(await (await fetch(url + '/sw.js')).text()).toContain("VERSION = '0.0.0-test'");
	});

	it('answers health without a token, and nothing else', async () => {
		expect((await fetch(url + '/api/health')).status).toBe(200);
		expect((await fetch(url + '/api/me')).status).toBe(401);
		expect((await fetch(url + '/api/history')).status).toBe(401);
		expect((await post('/api/turn', { text: 'hi' })).status).toBe(401);
	});
});

describe('pairing over HTTP', () => {
	it('a wrong code is refused, the right one answers a token', async () => {
		const { code } = devices.issueCode();
		const wrong = await post('/api/pair', { code: '000000', name: 'pixel' });
		expect(wrong.status).toBe(403);
		expect(await wrong.json()).toMatchObject({ error: 'pair-wrong' });
		const right = await post('/api/pair', { code, name: 'pixel' });
		expect(right.status).toBe(200);
		const body = (await right.json()) as { token: string; device: { name: string } };
		expect(body.device.name).toBe('pixel');
		token = body.token;
		const me = await fetch(url + '/api/me', { headers: auth() });
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({
			device: { name: 'pixel' },
			assistant: { name: 'Onto' },
			stt: 'openai',
			tts: 'piper'
		});
	});

	it('a nameless pairing is a 400', async () => {
		devices.issueCode();
		expect((await post('/api/pair', { code: '123456', name: '' })).status).toBe(400);
	});

	it('bad JSON is a 400', async () => {
		expect((await post('/api/pair', '{nope')).status).toBe(400);
	});
});

describe('a turn over HTTP', () => {
	it('streams the events of a typed turn', async () => {
		const res = await post('/api/turn', { text: 'add a task: call mum' }, auth());
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/x-ndjson/);
		const events = await lines(res);
		expect(events.map((e) => e.type)).toEqual(['thinking', 'action', 'action', 'thinking', 'reply', 'audio', 'done']);
		expect(events.find((e) => e.type === 'reply')).toMatchObject({ text: 'Added #3, call mum.' });
	});

	it('takes audio as the body', async () => {
		const res = await post('/api/turn', new TextEncoder().encode('what is on today'), {
			...auth(),
			'Content-Type': 'audio/webm'
		});
		const events = await lines(res);
		expect(events[0]).toEqual({ type: 'transcript', text: 'what is on today' });
	});

	it('refuses audio over the ceiling', async () => {
		const res = await post('/api/turn', new Uint8Array(MAX_AUDIO_BYTES + 1), {
			...auth(),
			'Content-Type': 'audio/webm'
		}).catch(() => null);
		// the server closes the socket on an oversized body; either a 413 or a dropped connection is a refusal
		if (res) expect(res.status).toBe(413);
	});

	it('asks, then takes the answer on /api/confirm', async () => {
		const asked = await lines(await post('/api/turn', { text: 'remove notebook 7' }, auth()));
		const confirm = asked.find((e) => e.type === 'confirm') as { id: string } | undefined;
		expect(confirm).toBeDefined();
		const me = (await (await fetch(url + '/api/me', { headers: auth() })).json()) as { pending: { id: string } | null };
		expect(me.pending?.id).toBe(confirm?.id);
		const done = await lines(await post('/api/confirm', { id: confirm?.id, yes: true }, auth()));
		expect(done.map((e) => e.type)).toContain('reply');
	});

	it('keeps the history per phone', async () => {
		const res = await fetch(url + '/api/history', { headers: auth() });
		const body = (await res.json()) as { turns: { heard: string }[] };
		expect(body.turns.map((t) => t.heard)).toContain('add a task: call mum');
	});

	it('forgets the phone on request', async () => {
		expect((await post('/api/forget', {}, auth())).status).toBe(200);
		expect((await fetch(url + '/api/me', { headers: auth() })).status).toBe(401);
	});
});

describe('rate limiting', () => {
	it('so many in a window, then no', () => {
		const limit = new RateLimit(3, 1000);
		expect([limit.allow('a', 0), limit.allow('a', 1), limit.allow('a', 2), limit.allow('a', 3)]).toEqual([
			true,
			true,
			true,
			false
		]);
		expect(limit.allow('b', 3)).toBe(true);
		expect(limit.allow('a', 1001)).toBe(true);
	});

	it('pairing is limited per address', async () => {
		let last = 0;
		for (let i = 0; i < PAIRING_RATE_LIMIT + 2; i++) last = (await post('/api/pair', { code: '1', name: 'x' })).status;
		expect(last).toBe(429);
	});
});
