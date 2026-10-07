import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { requestStop, startControl } from '../src/control.js';

it('stops a foreground server through its private control socket', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'onto-control-'));
	let stops = 0;
	try {
		const close = await startControl(dir, () => stops++);
		expect(await requestStop(dir, 'probe')).toBe(true);
		expect(stops).toBe(0);
		expect(await requestStop(dir)).toBe(true);
		expect(stops).toBe(1);
		await close();
		expect(await requestStop(dir)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
