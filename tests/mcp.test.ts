import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OntoplanoMcp, McpError, matchesAny, offeredTools, toLlmTools, trimDescription } from '../src/mcp.js';

/** An app that speaks the same simplest-legal MCP ontoplano does, plus one event-stream answer. */
let server: Server;
let url: string;
const seen: { method: string; auth: string | undefined; params: unknown }[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const msg = JSON.parse(body) as { id: number; method: string; params: unknown };
			seen.push({ method: msg.method, auth: req.headers.authorization, params: msg.params });
			if (req.headers.authorization !== 'Bearer good') {
				res.writeHead(401, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ error: 'unauthorized' }));
			}
			const answer = (result: unknown): void => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
			};
			switch (msg.method) {
				case 'initialize':
					return answer({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake' } });
				case 'tools/list':
					return answer({
						tools: [
							{
								name: 'today',
								description: 'Today. ' + 'x'.repeat(500),
								inputSchema: { type: 'object', properties: {} }
							},
							{
								name: 'add_task',
								description: 'Add.',
								inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
							},
							{
								name: 'remove_task',
								description: 'Remove.',
								inputSchema: { type: 'object', properties: { id: { type: 'integer' } } }
							}
						]
					});
				case 'tools/call': {
					const p = msg.params as { name: string; arguments: Record<string, unknown> };
					if (p.name === 'boom') {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						return res.end(
							JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'bad params' } })
						);
					}
					if (p.name === 'streamed') {
						res.writeHead(200, { 'Content-Type': 'text/event-stream' });
						return res.end(
							`: keepalive\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"ok":1}' }], isError: false } })}\n\n`
						);
					}
					if (p.name === 'refused')
						return answer({ content: [{ type: 'text', text: 'no such thing' }], isError: true });
					return answer({
						content: [{ type: 'text', text: JSON.stringify({ id: 5, after: { title: p.arguments.title } }) }],
						isError: false
					});
				}
				default:
					return answer({});
			}
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const address = server.address() as { port: number };
	url = `http://127.0.0.1:${address.port}`;
});
afterAll(() => server.close());

describe('the MCP client', () => {
	it('initialises once, then lists', async () => {
		const mcp = new OntoplanoMcp(url, 'good');
		const tools = await mcp.listTools();
		expect(tools.map((t) => t.name)).toEqual(['today', 'add_task', 'remove_task']);
		await mcp.listTools();
		expect(seen.filter((s) => s.method === 'initialize')).toHaveLength(1);
		expect(seen[0]?.auth).toBe('Bearer good');
	});

	it('calls, and parses what came back', async () => {
		const mcp = new OntoplanoMcp(url, 'good');
		const r = await mcp.call('add_task', { title: 'milk' });
		expect(r.ok).toBe(true);
		expect(r.structured).toEqual({ id: 5, after: { title: 'milk' } });
	});

	it("a tool's own refusal is ok: false, not a throw", async () => {
		const r = await new OntoplanoMcp(url, 'good').call('refused', {});
		expect(r.ok).toBe(false);
		expect(r.text).toBe('no such thing');
	});

	it('a protocol error throws with its message', async () => {
		await expect(new OntoplanoMcp(url, 'good').call('boom', {})).rejects.toThrow(/bad params/);
	});

	it('reads an event-stream answer', async () => {
		const r = await new OntoplanoMcp(url, 'good').call('streamed', {});
		expect(r.structured).toEqual({ ok: 1 });
	});

	it('a refused token is named as such', async () => {
		await expect(new OntoplanoMcp(url, 'bad').listTools()).rejects.toThrow(McpError);
		await expect(new OntoplanoMcp(url, 'bad').listTools()).rejects.toThrow(/refused the token/);
	});
});

describe('choosing tools', () => {
	const all = [
		{ name: 'today', description: 'A. B. C.', inputSchema: { type: 'object', properties: {} } },
		{
			name: 'add_task',
			description: 'Add.',
			inputSchema: {
				type: 'object',
				properties: { title: { type: 'string' }, meta: { type: 'object', deprecated: true } },
				required: ['title', 'meta']
			}
		},
		{ name: 'remove_task', description: 'Remove.', inputSchema: { type: 'object', properties: {} } },
		{ name: 'remove_note', description: 'Remove.', inputSchema: { type: 'object', properties: {} } }
	];

	it('matches names and * patterns', () => {
		expect(matchesAny('remove_task', ['remove_*'])).toBe(true);
		expect(matchesAny('remove_task', ['*_task'])).toBe(true);
		expect(matchesAny('remove_task', ['remove'])).toBe(false);
		expect(matchesAny('anything', ['*'])).toBe(true);
		expect(matchesAny('a.b', ['a.b'])).toBe(true);
		expect(matchesAny('axb', ['a.b'])).toBe(false);
	});

	it('offers in the order the config names, once each, wildcards expanded', () => {
		expect(offeredTools(all, ['remove_*', 'today', 'remove_task', 'nope'], 100).map((t) => t.name)).toEqual([
			'remove_task',
			'remove_note',
			'today'
		]);
		expect(offeredTools(all, ['*'], 100).map((t) => t.name)).toEqual(all.map((t) => t.name));
		expect(offeredTools(all, [], 100)).toEqual([]);
	});

	it('cuts descriptions at a sentence', () => {
		expect(trimDescription('One. Two. Three.', 9)).toBe('One. Two.');
		expect(trimDescription('x'.repeat(50), 10)).toBe('xxxxxxxxxx…');
		expect(trimDescription('short', 10)).toBe('short');
		expect(offeredTools(all, ['today'], 5)[0]?.description).toBe('A. B.');
	});

	it('drops deprecated fields for the model', () => {
		const llm = toLlmTools(offeredTools(all, ['add_task'], 100));
		expect(llm[0]?.function.parameters).toEqual({
			type: 'object',
			properties: { title: { type: 'string' } },
			required: ['title']
		});
	});
});
