import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { checkLangfuse } from '../src/langfuse-check.js';

it('reads the service file, checks the configured host with Basic auth, and reports success', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'onto-langfuse-check-'));
	try {
		const file = join(dir, 'langfuse.env');
		writeFileSync(
			file,
			'LANGFUSE_PUBLIC_KEY=pk-test\nLANGFUSE_SECRET_KEY=sk-test\nLANGFUSE_BASE_URL=http://127.0.0.1:3000\n'
		);
		const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
		expect(await checkLangfuse({}, fetcher as typeof fetch, file)).toBe(0);
		expect(fetcher).toHaveBeenCalledOnce();
		const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.href).toBe('http://127.0.0.1:3000/api/public/projects');
		expect(options.headers).toEqual({ Authorization: `Basic ${Buffer.from('pk-test:sk-test').toString('base64')}` });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it('reports rejected credentials without sending a trace', async () => {
	const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
	expect(
		await checkLangfuse(
			{ LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: 'sk-test', LANGFUSE_BASE_URL: 'http://localhost:3000' },
			fetcher as typeof fetch,
			'/nonexistent/langfuse.env'
		)
	).toBe(1);
	expect(fetcher).toHaveBeenCalledOnce();
});
