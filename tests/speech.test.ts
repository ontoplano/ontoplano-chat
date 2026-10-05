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

	it('a server that is not there is said so', async () => {
		expect(await speechServerCheck('http://127.0.0.1:1', 'x', undefined)).toMatch(/nothing answers at/);
	});
});
