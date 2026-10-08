import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIRM } from '../src/constants.js';
import { FAKE_TOOLS, FakeOntoplano, fakeLlm, fakeStt, fakeTts } from '../src/fakes.js';
import { History } from '../src/history.js';
import type { Llm } from '../src/llm.js';
import { offeredTools } from '../src/mcp.js';
import { Assistant, yesOrNo, type TurnEvent } from '../src/turn.js';

let dir: string;
let app: FakeOntoplano;
let llm: ReturnType<typeof fakeLlm>;
let history: History;
let assistant: Assistant;
const OFFERED = ['today', 'tasks', 'add_task', 'finish_task', 'remove_notebook'];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'onto-turn-'));
	app = new FakeOntoplano();
	llm = fakeLlm();
	history = new History(dir);
	assistant = new Assistant({
		name: 'Onto',
		language: 'en',
		appUrl: 'https://app.example',
		confirm: DEFAULT_CONFIRM,
		historyTurns: 3,
		maxToolRounds: 4,
		llm,
		stt: fakeStt,
		tts: fakeTts,
		mcp: app,
		tools: () => offeredTools(FAKE_TOOLS, OFFERED, 300),
		history
	});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const collect = async (fn: (emit: (e: TurnEvent) => void) => Promise<void>): Promise<TurnEvent[]> => {
	const events: TurnEvent[] = [];
	await fn((e) => events.push(e));
	return events;
};
const types = (events: TurnEvent[]): string[] => events.map((e) => e.type);

describe('a turn', () => {
	it('hears, acts, answers, speaks — and writes it down', async () => {
		const events = await collect((emit) => assistant.turn('pixel', { text: 'add a task: water the plants' }, emit));
		expect(types(events)).toEqual(['thinking', 'action', 'action', 'thinking', 'reply', 'audio', 'done']);
		const done = events.find((e) => e.type === 'action' && e.status === 'done');
		expect(done).toMatchObject({
			name: 'add_task',
			summary: 'add task · #3 water the plants',
			link: 'https://app.example/tasks/todo?edit=3'
		});
		expect(events.find((e) => e.type === 'reply')).toMatchObject({ text: 'Added #3, water the plants.' });
		expect(app.tasks.map((t) => t.title)).toContain('water the plants');
		const [record] = history.recent('pixel');
		expect(record).toMatchObject({
			device: 'pixel',
			heard: 'add a task: water the plants',
			reply: 'Added #3, water the plants.'
		});
		expect(record?.actions[0]).toMatchObject({ name: 'add_task', ok: true });
	});

	it('skips voice synthesis when the device has muted replies', async () => {
		const events = await collect((emit) => assistant.turn('pixel', { text: 'hello', speak: false }, emit));
		expect(types(events)).toEqual(['thinking', 'reply', 'done']);
	});

	it('reports actual offered tools and does not invent token scopes', async () => {
		const events = await collect((emit) =>
			assistant.turn('pixel', { text: 'what tools does my token grant?', speak: false }, emit)
		);
		const reply = events.find((event) => event.type === 'reply');
		expect(reply).toMatchObject({ text: expect.stringContaining('5 tools available') });
		expect(reply).toMatchObject({ text: expect.stringContaining('server did not report') });
		expect(app.calls).toEqual([]);
	});

	it('reports the notebook boundary supplied by the MCP server', async () => {
		const scoped = new Assistant({
			name: 'Onto',
			language: 'pt-BR',
			appUrl: 'https://app.example',
			confirm: DEFAULT_CONFIRM,
			historyTurns: 3,
			maxToolRounds: 4,
			llm,
			stt: fakeStt,
			tts: fakeTts,
			mcp: app,
			tools: () => offeredTools(FAKE_TOOLS, OFFERED, 300),
			mcpContext: () => ({
				instructions: 'Use the tool schemas.',
				access: { kind: 'notebook', id: 7, label: 'notebook: Sample' }
			}),
			history
		});
		const events = await collect((emit) =>
			scoped.turn('pixel', { text: 'quais ferramentas meu token permite?', speak: false }, emit)
		);
		expect(events.find((event) => event.type === 'reply')).toMatchObject({
			text: expect.stringContaining('notebook: Sample')
		});
		await collect((emit) => scoped.turn('pixel', { text: 'hello', speak: false }, emit));
		expect(llm.prompts.at(-1)?.[0]).toMatchObject({ content: expect.stringContaining('notebook: Sample') });
	});

	it('retries a clear task creation with the available tool after a model refusal', async () => {
		let calls = 0;
		const toolSets: string[][] = [];
		const scripted: Llm = {
			model: 'synthetic-refusal',
			async chat(_messages, tools) {
				toolSets.push(tools.map((item) => item.function.name));
				calls++;
				if (calls === 1) return { content: 'I cannot create tasks.', toolCalls: [], raw: [], thinking: '' };
				if (calls === 2) {
					const raw = [
						{
							id: 'task-1',
							type: 'function' as const,
							function: { name: 'add_task', arguments: '{"title":"organizar arquivos"}' }
						}
					];
					return {
						content: '',
						toolCalls: [{ id: 'task-1', name: 'add_task', args: { title: 'organizar arquivos' } }],
						raw,
						thinking: ''
					};
				}
				return { content: 'Criei a tarefa.', toolCalls: [], raw: [], thinking: '' };
			},
			async check() {
				return null;
			},
			async pull() {
				return null;
			},
			async models() {
				return [];
			}
		};
		const focused = new Assistant({
			name: 'Onto',
			language: 'pt-BR',
			appUrl: 'https://app.example',
			confirm: DEFAULT_CONFIRM,
			historyTurns: 3,
			maxToolRounds: 4,
			llm: scripted,
			stt: fakeStt,
			tts: fakeTts,
			mcp: app,
			tools: () => offeredTools(FAKE_TOOLS, OFFERED, 300),
			history
		});
		const events = await collect((emit) =>
			focused.turn('pixel', { text: 'cria uma task: organizar arquivos', speak: false }, emit)
		);
		expect(toolSets[1]).toContain('add_task');
		expect(app.calls.map((item) => item.name)).toEqual(['add_task']);
		expect(events.find((event) => event.type === 'reply')).toMatchObject({ text: 'Criei a tarefa.' });
	});

	it('expands the tool list for an action outside the initial shortlist', async () => {
		const catalog = [
			...Array.from({ length: 35 }, (_, index) => ({
				name: `unrelated_${index}`,
				description: '',
				inputSchema: { type: 'object' }
			})),
			{ name: 'record_measurement', description: 'Record a measurement.', inputSchema: { type: 'object' } }
		];
		const seen: string[][] = [];
		const called: string[] = [];
		const model: Llm = {
			model: 'synthetic',
			async chat(_messages, tools) {
				seen.push(tools.map((item) => item.function.name));
				if (seen.length === 1) return { content: 'I have no such tool.', toolCalls: [], raw: [], thinking: '' };
				if (seen.length === 2) {
					const raw = [
						{
							id: 'measurement',
							type: 'function' as const,
							function: { name: 'record_measurement', arguments: '{}' }
						}
					];
					return {
						content: '',
						toolCalls: [{ id: 'measurement', name: 'record_measurement', args: {} }],
						raw,
						thinking: ''
					};
				}
				return { content: 'Recorded.', toolCalls: [], raw: [], thinking: '' };
			},
			async check() {
				return null;
			},
			async pull() {
				return null;
			},
			async models() {
				return [];
			}
		};
		const expanded = new Assistant({
			name: 'Onto',
			language: 'en',
			appUrl: 'https://app.example',
			confirm: DEFAULT_CONFIRM,
			historyTurns: 3,
			maxToolRounds: 4,
			llm: model,
			stt: fakeStt,
			tts: fakeTts,
			mcp: {
				async call(name) {
					called.push(name);
					return { ok: true, text: '{"ok":true}', structured: { ok: true } };
				}
			},
			tools: () => catalog,
			history
		});
		await collect((emit) => expanded.turn('pixel', { text: 'registre uma medição', speak: false }, emit));
		expect(seen[0]).not.toContain('record_measurement');
		expect(seen[1]).toContain('record_measurement');
		expect(called).toEqual(['record_measurement']);
	});

	it('transcribes audio first and shows the words', async () => {
		const events = await collect((emit) =>
			assistant.turn(
				'pixel',
				{ audio: { bytes: new TextEncoder().encode('what is on today'), mime: 'audio/webm' } },
				emit
			)
		);
		expect(events[0]).toEqual({ type: 'transcript', text: 'what is on today' });
		expect(app.calls.map((c) => c.name)).toEqual(['today']);
	});

	it('an empty transcript is an error, not a turn', async () => {
		const events = await collect((emit) =>
			assistant.turn('pixel', { audio: { bytes: new Uint8Array(), mime: 'audio/webm' } }, emit)
		);
		expect(types(events)).toEqual(['transcript', 'error', 'done']);
		expect(app.calls).toEqual([]);
	});

	it('a tool the model was not offered is refused here', async () => {
		const events = await collect((emit) => assistant.turn('pixel', { text: 'use the secret' }, emit));
		const failed = events.find((e) => e.type === 'action' && e.status === 'failed');
		expect(failed).toMatchObject({ name: 'secret_tool' });
		expect(app.calls).toEqual([]);
	});

	it('redirects MCP discovery to the offered task tool without showing an error', async () => {
		const seen: string[][] = [];
		const model: Llm = {
			model: 'synthetic-discovery',
			async chat(messages, tools) {
				seen.push(tools.map((tool) => tool.function.name));
				if (seen.length === 1) {
					expect(messages[0]?.content).toContain('tools/list');
					return {
						content: '',
						toolCalls: [{ id: 'discovery', name: 'tools/list', args: {} }],
						raw: [{ id: 'discovery', type: 'function', function: { name: 'tools/list', arguments: '{}' } }],
						thinking: ''
					};
				}
				if (seen.length === 2) {
					expect(messages.at(-1)).toMatchObject({
						role: 'tool',
						tool_call_id: 'discovery',
						content: expect.stringContaining('tasks')
					});
					return {
						content: '',
						toolCalls: [{ id: 'open-tasks', name: 'tasks', args: { status: 'open' } }],
						raw: [
							{
								id: 'open-tasks',
								type: 'function',
								function: { name: 'tasks', arguments: '{"status":"open"}' }
							}
						],
						thinking: ''
					};
				}
				return { content: 'Você tem tarefas em aberto.', toolCalls: [], raw: [], thinking: '' };
			},
			async check() {
				return null;
			},
			async pull() {
				return null;
			},
			async models() {
				return [];
			}
		};
		const focused = new Assistant({
			name: 'Onto',
			language: 'pt-BR',
			appUrl: 'https://app.example',
			confirm: DEFAULT_CONFIRM,
			historyTurns: 3,
			maxToolRounds: 4,
			llm: model,
			stt: fakeStt,
			tts: fakeTts,
			mcp: app,
			tools: () => offeredTools(FAKE_TOOLS, OFFERED, 300),
			history
		});
		const events = await collect((emit) =>
			focused.turn('pixel', { text: 'tem alguma tarefa em aberto?', speak: false }, emit)
		);
		expect(seen[0]).toContain('tasks');
		expect(app.calls.map((call) => call.name)).toEqual(['tasks']);
		expect(events.filter((event) => event.type === 'action' && event.status === 'failed')).toEqual([]);
		expect(events.find((event) => event.type === 'reply')).toMatchObject({
			text: 'Você tem tarefas em aberto.'
		});
	});

	it('remembers the last turns, as words only', async () => {
		await collect((emit) => assistant.turn('pixel', { text: 'hello' }, emit));
		await collect((emit) => assistant.turn('pixel', { text: 'add a task: one' }, emit));
		await collect((emit) => assistant.turn('pixel', { text: 'hello' }, emit));
		const last = llm.prompts[llm.prompts.length - 1]!;
		const roles = last.map((m) => m.role);
		expect(roles[0]).toBe('system');
		expect(roles).not.toContain('tool');
		expect(last.filter((m) => m.role === 'user')).toHaveLength(3);
	});

	it('another phone is another conversation', async () => {
		await collect((emit) => assistant.turn('pixel', { text: 'hello' }, emit));
		await collect((emit) => assistant.turn('tablet', { text: 'hello' }, emit));
		const last = llm.prompts[llm.prompts.length - 1]!;
		expect(last.filter((m) => m.role === 'user')).toHaveLength(1);
	});
});

describe('the confirmation gate', () => {
	it('stops before a destructive tool and asks', async () => {
		const events = await collect((emit) => assistant.turn('pixel', { text: 'remove notebook 7' }, emit));
		expect(types(events)).toEqual(['thinking', 'confirm', 'done']);
		expect(events[1]).toMatchObject({ name: 'remove_notebook', question: 'remove notebook (id 7)?' });
		expect(app.notebooks).toHaveLength(2);
		expect(assistant.pending('pixel')?.question).toBe('remove notebook (id 7)?');
		expect(history.recent('pixel')[0]?.asked).toBe('remove notebook (id 7)?');
	});

	it('a yes runs it and finishes the turn', async () => {
		const asked = await collect((emit) => assistant.turn('pixel', { text: 'remove notebook 7' }, emit));
		const id = (asked[1] as { id: string }).id;
		const events = await collect((emit) => assistant.resume('pixel', id, true, emit));
		expect(types(events)).toEqual(['action', 'action', 'thinking', 'reply', 'audio', 'done']);
		expect(app.notebooks).toHaveLength(1);
		expect(assistant.pending('pixel')).toBeNull();
	});

	it('a no leaves it alone and tells the model so', async () => {
		const asked = await collect((emit) => assistant.turn('pixel', { text: 'remove notebook 7' }, emit));
		const id = (asked[1] as { id: string }).id;
		const events = await collect((emit) => assistant.resume('pixel', id, false, emit));
		expect(app.notebooks).toHaveLength(2);
		expect(events.find((e) => e.type === 'reply')).toMatchObject({ text: expect.stringContaining('not done') });
		expect(history.recent('pixel')[0]?.actions[0]).toMatchObject({
			name: 'remove_notebook',
			ok: false,
			summary: 'declined'
		});
	});

	it('is answered by voice too', async () => {
		await collect((emit) => assistant.turn('pixel', { text: 'remove notebook 7' }, emit));
		const events = await collect((emit) => assistant.turn('pixel', { text: 'Yes.' }, emit));
		expect(types(events)).toContain('reply');
		expect(app.notebooks).toHaveLength(1);
	});

	it('lapses when something else is said', async () => {
		await collect((emit) => assistant.turn('pixel', { text: 'remove notebook 7' }, emit));
		await collect((emit) => assistant.turn('pixel', { text: 'what is on today' }, emit));
		expect(assistant.pending('pixel')).toBeNull();
		expect(app.notebooks).toHaveLength(2);
	});

	it('a stale id is nothing', async () => {
		const events = await collect((emit) => assistant.resume('pixel', 'nope', true, emit));
		expect(types(events)).toEqual(['error', 'done']);
	});
});

describe('yes or no', () => {
	it('hears both languages', () => {
		expect(yesOrNo('Sim', 'pt-BR')).toBe(true);
		expect(yesOrNo('não, deixa', 'pt-BR')).toBe(false);
		expect(yesOrNo('yes please', 'en')).toBe(true);
		expect(yesOrNo('No!', 'en')).toBe(false);
		expect(yesOrNo('pode ir', 'pt-BR')).toBe(true);
	});

	it('a sentence is not an answer', () => {
		expect(yesOrNo('yes but first add a task to buy milk', 'en')).toBeNull();
		expect(yesOrNo('what is on today', 'en')).toBeNull();
		expect(yesOrNo('', 'en')).toBeNull();
	});
});
