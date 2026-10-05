import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openAiLlm } from '../src/llm.js';

/** An Ollama-shaped runner: lists what it has at /v1/models, pulls at /api/pull. */
let server: Server;
let url: string;
const pulled = new Set<string>();

beforeAll(async () => {
	server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			if (req.url === '/v1/models') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ data: [...pulled].map((id) => ({ id })) }));
			}
			if (req.url === '/api/pull') {
				pulled.add((JSON.parse(body) as { model: string }).model);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ status: 'success' }));
			}
			res.writeHead(404);
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => server.close());

describe('the runner', () => {
	it('with no models pulled is not fine, and pulls on request', async () => {
		const llm = openAiLlm({ url, model: 'qwen2.5:7b', timeoutMs: 5000 });
		expect(await llm.check()).toMatch(/not pulled: the runner lists no models/);
		expect(await llm.pull()).toBeNull();
		expect(await llm.check()).toBeNull();
	});

	it('a tag counts as the model', async () => {
		pulled.add('llama3.1:8b');
		expect(await openAiLlm({ url, model: 'llama3.1', timeoutMs: 5000 }).check()).toBeNull();
	});

	it('a runner that is not there is said so', async () => {
		expect(await openAiLlm({ url: 'http://127.0.0.1:1/v1', model: 'x', timeoutMs: 5000 }).check()).toMatch(
			/no model runner/
		);
	});
});
