import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { expect, it } from 'vitest';

it('logs endpoints, timings and failure reasons without contacting an Ontoplano server', async () => {
	const paths: string[] = [];
	const server = createServer((req, res) => {
		paths.push(req.url ?? '');
		res.setHeader('Content-Type', 'application/json');
		if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'eval-test-model' }] }));
		if (req.url === '/v1/chat/completions')
			return res.end(
				JSON.stringify({
					choices: [{ message: { content: 'I cannot do that.' } }],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
				})
			);
		res.statusCode = 404;
		res.end('{}');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const port = (server.address() as { port: number }).port;
		const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
			const child = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), ['eval/run.ts'], {
				cwd: process.cwd(),
				env: {
					...process.env,
					EVAL_MODEL_URL: `http://127.0.0.1:${port}/v1`,
					EVAL_MODEL_NAME: 'eval-test-model',
					ONTOPLANO_MCP_TOKEN: 'must-never-be-used',
					ONTOPLANO_CHAT_CONFIG: '/nonexistent/production-config.toml',
					LANGFUSE_PUBLIC_KEY: '',
					LANGFUSE_SECRET_KEY: ''
				}
			});
			let text = '';
			child.stdout.on('data', (chunk: Buffer) => {
				text += chunk.toString();
			});
			child.stderr.on('data', (chunk: Buffer) => {
				text += chunk.toString();
			});
			child.on('error', reject);
			child.on('close', (code) => resolve({ code, text }));
		});
		expect(output.code).toBe(1);
		expect(output.text).toContain(`Model endpoint: http://127.0.0.1:${port}/v1`);
		expect(output.text).toContain('Ontoplano MCP: synthetic in memory');
		expect(output.text).toMatch(/model round 1: [\d.]+s/);
		expect(output.text).toMatch(/FAIL in [\d.]+s/);
		expect(output.text).toContain('reason: Expected tool sequence');
		expect(output.text).toContain('Cases:                       29');
		expect(output.text).not.toContain('must-never-be-used');
		expect(paths.every((path) => path === '/v1/models' || path === '/v1/chat/completions')).toBe(true);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}, 20_000);
