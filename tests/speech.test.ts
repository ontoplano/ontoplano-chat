import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { httpStt, openAiTts, speechServerCheck, speechServerPull } from '../src/speech.js';

/** A Speaches-shaped server: lists what it has, downloads on POST, 404s a turn for a model it lacks. */
let server: Server;
let url: string;
const installed = new Set(['Systran/faster-whisper-small']);

beforeAll(async () => {
	server = createServer((req, res) => {
		const path = req.url ?? '/';
		if (path === '/v1/models' && req.method === 'GET') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ data: [...installed].map((id) => ({ id })) }));
		}
		if (path === '/v1/audio/transcriptions' && req.method === 'POST') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ text: '' }));
		}
		if (path === '/v1/audio/speech' && req.method === 'POST') {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			return res.end('404: Not Found');
		}
		if (path.startsWith('/v1/models/') && req.method === 'POST') {
			installed.add(decodeURIComponent(path.slice('/v1/models/'.length)));
			res.writeHead(201);
			return res.end();
		}
		res.writeHead(200);
		res.end('ok');
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe('a local speech server', () => {
	it('is fine with a model it has', async () => {
		expect(await speechServerCheck(url, 'Systran/faster-whisper-small', undefined)).toBeNull();
	});

	it('says which model it lacks, and downloads it on request', async () => {
		expect(await speechServerCheck(url, 'speaches-ai/Kokoro-82M-v1.0-ONNX', undefined)).toMatch(
			/Kokoro.*not installed/
		);
		expect(await speechServerPull(url, 'speaches-ai/Kokoro-82M-v1.0-ONNX', undefined)).toBeNull();
		expect(await speechServerCheck(url, 'speaches-ai/Kokoro-82M-v1.0-ONNX', undefined)).toBeNull();
	});

	it('is named by what it is, not by its API', () => {
		const ears = httpStt({
			kind: 'openai',
			url,
			path: '/v1/audio/transcriptions',
			model: 'Systran/faster-whisper-small',
			language: 'pt'
		});
		expect(ears.about).toBe(`Systran/faster-whisper-small at ${url} (an OpenAI-compatible server)`);
		const voice = openAiTts({ url, model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'af_heart' });
		expect(voice.about).toBe(`af_heart at ${url} (an OpenAI-compatible server)`);
		expect(httpStt({ kind: 'whispercpp', url, path: '/inference', model: '', language: 'pt' }).about).toBe(
			`whisper.cpp at ${url}`
		);
	});

	it('the ears are checked with a moment of silence, the voice with a word', async () => {
		const ears = httpStt({
			kind: 'openai',
			url,
			path: '/v1/audio/transcriptions',
			model: 'Systran/faster-whisper-small',
			language: 'pt'
		});
		expect(await ears.check()).toBeNull();
		const voice = openAiTts({ url, model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'af_heart' });
		expect(await voice.check()).toMatch(
			/answered 404 — Not Found to POST \/v1\/audio\/speech — is that a server with a voice/
		);
	});

	it('a server that is not there is said so', async () => {
		expect(await speechServerCheck('http://127.0.0.1:1', 'x', undefined)).toMatch(/nothing answers at/);
	});
});

describe('the language spoken', () => {
	it('auto asks whisper to detect it and hands it back as a code', async () => {
		const sent: string[] = [];
		const ears = httpStt({
			kind: 'openai',
			url: 'http://x',
			path: '/v1/audio/transcriptions',
			model: 'w',
			language: 'auto',
			fetchImpl: async (_u, init) => {
				const form = init?.body as FormData;
				sent.push(`${form.get('response_format')}|${form.get('language') ?? ''}`);
				return Response.json({ text: 'olá', language: 'portuguese' });
			}
		});
		expect(await ears.transcribe(new Uint8Array([1]), 'audio/webm')).toEqual({ text: 'olá', language: 'pt' });
		expect(sent[0]).toBe('verbose_json|');
	});

	it('a fixed language is sent, and nothing is claimed to be detected', async () => {
		const ears = httpStt({
			kind: 'openai',
			url: 'http://x',
			path: '/v1/audio/transcriptions',
			model: 'w',
			language: 'pt',
			fetchImpl: async () => Response.json({ text: 'olá' })
		});
		expect(await ears.transcribe(new Uint8Array([1]), 'audio/webm')).toEqual({ text: 'olá', language: null });
	});

	it('a Kokoro voice switches to the turn language, keeping its gender', async () => {
		const voices: string[] = [];
		const voice = openAiTts({
			url: 'http://x',
			model: 'k',
			voice: 'pm_alex',
			fetchImpl: async (_u, init) => {
				voices.push((JSON.parse(String(init?.body)) as { voice: string }).voice);
				return new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } });
			}
		});
		await voice.speak('hello', 'en');
		await voice.speak('olá', 'pt');
		expect(voices).toEqual(['am_michael', 'pm_alex']);
	});
});
