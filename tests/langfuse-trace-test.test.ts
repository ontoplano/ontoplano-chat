import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';

import { traceTest, waitForTrace } from '../src/langfuse-trace-test.js';

it('waits for the synthetic trace to appear by its exact ID', async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
		.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'span' }] }), { status: 200 }));
	const sleep = vi.fn(async () => {});
	expect(
		await waitForTrace(
			{ publicKey: 'pk-test', secretKey: 'sk-test', baseUrl: 'http://localhost:3000' },
			'synthetic-trace',
			fetcher as typeof fetch,
			3,
			sleep
		)
	).toBe(true);
	expect(fetcher).toHaveBeenCalledTimes(2);
	expect(fetcher.mock.calls[0][0].href).toContain('traceId=synthetic-trace');
	expect(sleep).toHaveBeenCalledOnce();
});

it('exports a synthetic span to a local collector and finds it again', async () => {
	let received = false;
	const server = createServer((req, res) => {
		if (req.url === '/api/public/projects') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{"data":[{"id":"synthetic"}]}');
		} else if (req.url === '/api/public/otel/v1/traces' && req.method === 'POST') {
			req.resume();
			req.on('end', () => {
				received = true;
				res.writeHead(200);
				res.end();
			});
		} else if (req.url?.startsWith('/api/public/v2/observations?')) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ data: received ? [{ id: 'synthetic' }] : [] }));
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('expected TCP address');
		expect(
			await traceTest({ publicKey: 'pk-test', secretKey: 'sk-test', baseUrl: `http://127.0.0.1:${address.port}` })
		).toBe(0);
		expect(received).toBe(true);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}, 10000);
