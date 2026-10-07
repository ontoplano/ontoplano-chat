import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { DEFAULT_CONFIRM } from '../src/constants.js';
import { FakeOntoplano, FAKE_TOOLS, fakeLlm, fakeStt, fakeTts } from '../src/fakes.js';
import { History } from '../src/history.js';
import { disabledTelemetry, langfuseTelemetry, redact, type Telemetry } from '../src/observability.js';
import { Assistant, type TurnEvent } from '../src/turn.js';

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('removes secrets from nested trace data and free text', () => {
	const result = redact(
		{
			Authorization: 'Bearer private-123',
			args: { token: 'private-123', title: 'use private-123 and sk_abcdefghijklmnop' }
		},
		['private-123']
	);
	expect(JSON.stringify(result)).not.toContain('private-123');
	expect(JSON.stringify(result)).not.toContain('sk_abcdefghijklmnop');
	expect(result).toMatchObject({ Authorization: '[REDACTED]', args: { token: '[REDACTED]' } });
});

it('works with tracing disabled', async () => {
	const value = await disabledTelemetry().run('turn', 'agent', { text: 'hello' }, async (span) => {
		span.update({ output: 'hi' });
		return 'hi';
	});
	expect(value).toBe('hi');
});

it('answers when the configured Langfuse endpoint is unavailable', async () => {
	const telemetry = langfuseTelemetry({
		LANGFUSE_PUBLIC_KEY: 'pk_test_abcdefghijkl',
		LANGFUSE_SECRET_KEY: 'sk_test_abcdefghijkl',
		LANGFUSE_BASE_URL: 'http://127.0.0.1:1'
	});
	expect(
		await telemetry.run('offline', 'agent', { sessionId: 'synthetic' }, async (span) => {
			span.update({ output: 'ok' });
			return 'ok';
		})
	).toBe('ok');
	await expect(telemetry.shutdown()).resolves.toBeUndefined();
});

it('keeps model and failed MCP calls under the current turn', async () => {
	const entries: { name: string; parent?: string; updates: unknown[] }[] = [];
	const active: string[] = [];
	const telemetry: Telemetry = {
		async run(name, _kind, _input, work) {
			const row = { name, parent: active.at(-1), updates: [] as unknown[] };
			entries.push(row);
			active.push(name);
			try {
				return await work({ update: (data) => row.updates.push(data) });
			} finally {
				active.pop();
			}
		},
		async shutdown() {}
	};
	const dir = mkdtempSync(join(tmpdir(), 'onto-observe-'));
	directories.push(dir);
	const app = new FakeOntoplano();
	app.call = async () => ({ ok: false, text: 'synthetic failure', structured: undefined });
	const assistant = new Assistant({
		name: 'Ontoplano',
		language: 'en',
		appUrl: 'http://synthetic.invalid',
		confirm: DEFAULT_CONFIRM,
		historyTurns: 3,
		maxToolRounds: 3,
		llm: fakeLlm(),
		stt: fakeStt,
		tts: fakeTts,
		mcp: app,
		tools: () => FAKE_TOOLS,
		history: new History(dir),
		telemetry
	});
	const events: TurnEvent[] = [];
	await assistant.turn('test-device', { text: 'add a task: water plants' }, (event) => events.push(event));
	expect(entries.map((entry) => [entry.name, entry.parent])).toEqual([
		['ontoplano-turn', undefined],
		['model-round-1', 'ontoplano-turn'],
		['add_task', 'ontoplano-turn'],
		['model-round-2', 'ontoplano-turn']
	]);
	expect(entries[2]?.updates).toEqual(
		expect.arrayContaining([expect.objectContaining({ level: 'ERROR', statusMessage: 'synthetic failure' })])
	);
	expect(events).toContainEqual(expect.objectContaining({ type: 'action', name: 'add_task', status: 'failed' }));
});
