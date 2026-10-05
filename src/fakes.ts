/*
 * Stand-ins for the model, the ears, the voice and the app.
 *
 * For the tests, and for `ONTOPLANO_CHAT_ENGINES=fake`, which runs the whole
 * thing with nothing installed: the phone screen can be looked at, the pairing
 * walked through, a turn watched end to end. The fake model understands a
 * handful of shapes — "add a task …", "what's today", "remove …" — enough to
 * exercise every path, including the confirmation gate.
 */
import type { Llm, Message, Reply } from './llm.js';
import type { LlmTool, McpTool, ToolResult } from './mcp.js';
import type { Stt, Tts } from './speech.js';
import type { ToolCaller } from './turn.js';

export const FAKE_TOOLS: McpTool[] = [
	{
		name: 'today',
		description: 'What is on the plan today. Ask this before answering "what should I be doing".',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'tasks',
		description: 'The open todos.',
		inputSchema: { type: 'object', properties: { tag: { type: 'string' } } }
	},
	{
		name: 'add_task',
		description: 'Put a task on the todo list. Leave the date off unless the person said when.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				scheduledDate: { type: 'string' },
				meta: { type: 'object', deprecated: true }
			},
			required: ['title']
		}
	},
	{
		name: 'finish_task',
		description: 'Tick a task done.',
		inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }
	},
	{
		name: 'remove_notebook',
		description: 'Delete a notebook and everything in it. Irreversible.',
		inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }
	},
	{
		name: 'secret_tool',
		description: 'A tool the token grants but the config does not offer.',
		inputSchema: { type: 'object', properties: {} }
	}
];

type Task = { id: number; title: string; status: 'todo' | 'done'; notebookSeq: number; scheduledDate: string | null };

/** The app, in memory. */
export class FakeOntoplano implements ToolCaller {
	tasks: Task[] = [
		{ id: 1, title: 'buy milk', status: 'todo', notebookSeq: 1, scheduledDate: null },
		{ id: 2, title: 'call the plumber', status: 'todo', notebookSeq: 2, scheduledDate: null }
	];
	notebooks = [
		{ id: 7, title: 'Kitchen' },
		{ id: 8, title: 'Garage' }
	];
	calls: { name: string; args: Record<string, unknown> }[] = [];

	async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		this.calls.push({ name, args });
		const ok = (structured: unknown): ToolResult => ({ ok: true, text: JSON.stringify(structured), structured });
		switch (name) {
			case 'today':
				return ok({
					date: '2026-10-04',
					blocks: [{ title: 'gym', start: '18:00' }],
					tasks: this.tasks.filter((t) => t.status === 'todo')
				});
			case 'tasks':
				return ok({
					items: this.tasks.filter((t) => t.status === 'todo'),
					count: this.tasks.filter((t) => t.status === 'todo').length
				});
			case 'add_task': {
				const title = String(args.title ?? '').trim();
				if (!title) return { ok: false, text: 'title is required', structured: undefined };
				const task: Task = {
					id: this.tasks.length + 1,
					title,
					status: 'todo',
					notebookSeq: this.tasks.length + 1,
					scheduledDate: typeof args.scheduledDate === 'string' ? args.scheduledDate : null
				};
				this.tasks.push(task);
				return ok({ id: task.id, before: null, after: task });
			}
			case 'finish_task': {
				const task = this.tasks.find((t) => t.id === args.id);
				if (!task) return { ok: false, text: 'no such task', structured: undefined };
				task.status = 'done';
				return ok({ id: task.id, after: task });
			}
			case 'remove_notebook': {
				const i = this.notebooks.findIndex((n) => n.id === args.id);
				if (i < 0) return { ok: false, text: 'no such notebook', structured: undefined };
				const [gone] = this.notebooks.splice(i, 1);
				return ok({ id: gone?.id, title: gone?.title, removed: true });
			}
			default:
				return { ok: false, text: `no tool ${name}`, structured: undefined };
		}
	}
}

let callSeq = 0;
const call = (name: string, args: Record<string, unknown>): Reply => {
	const id = `call_${++callSeq}`;
	return {
		content: '',
		toolCalls: [{ id, name, args }],
		raw: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
	};
};
const say = (content: string): Reply => ({ content, toolCalls: [], raw: [] });

/** A model that understands a few sentence shapes, in English and Portuguese. */
export function fakeLlm(): Llm & { prompts: Message[][] } {
	const prompts: Message[][] = [];
	return {
		model: 'fake',
		prompts,
		async check() {
			return null;
		},
		async pull() {
			return null;
		},
		async models() {
			return [];
		},
		async chat(messages, tools: LlmTool[]) {
			prompts.push(messages);
			const last = messages[messages.length - 1];
			const offered = new Set(tools.map((t) => t.function.name));
			// After a tool answered, say what it said.
			if (last?.role === 'tool') {
				const text = last.content;
				const assistantCall = [...messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls);
				const name = assistantCall?.role === 'assistant' ? assistantCall.tool_calls?.[0]?.function.name : undefined;
				if (text.startsWith('Error:') || text.includes('NOT done'))
					return say(`That was not done: ${text.replace(/^Error: /, '')}`);
				if (name === 'add_task') {
					const t = JSON.parse(text) as { after: Task };
					return say(`Added #${t.after.notebookSeq}, ${t.after.title}.`);
				}
				if (name === 'today') return say('Today you have gym at six, and two open todos.');
				if (name === 'tasks') {
					const t = JSON.parse(text) as { count: number };
					return say(`You have ${t.count} open todos.`);
				}
				if (name === 'remove_notebook') return say('The notebook is gone.');
				return say('Done.');
			}
			const user = [...messages].reverse().find((m) => m.role === 'user');
			const text = (user?.role === 'user' ? user.content : '').toLowerCase();
			let m: RegExpMatchArray | null;
			if (
				(m = text.match(/^(?:add|create|new|adiciona|cria|anota)(?: a| uma?)? (?:task|todo|tarefa)[:,]? (.+)$/)) &&
				offered.has('add_task')
			)
				return call('add_task', { title: (m[1] ?? '').replace(/[.!]$/, '') });
			if (/(today|hoje)/.test(text) && offered.has('today')) return call('today', {});
			if (/(todos|tasks|tarefas)/.test(text) && offered.has('tasks')) return call('tasks', {});
			if ((m = text.match(/(?:remove|delete|apaga|remove) (?:the )?notebook (\d+)/)) && offered.has('remove_notebook'))
				return call('remove_notebook', { id: Number(m[1]) });
			if (/secret/.test(text)) return call('secret_tool', {});
			if (/^(oi|olá|hello|hi)\b/.test(text)) return say('Hello. What shall I do?');
			return say(`You said: ${user?.role === 'user' ? user.content : ''}`);
		}
	};
}

/** Ears that hear whatever the bytes spell, so a test can send its sentence as audio. */
export const fakeStt: Stt = {
	kind: 'openai',
	about: 'fake ears',
	async transcribe(audio) {
		return Buffer.from(audio).toString('utf8');
	},
	async check() {
		return null;
	}
};

/** A voice that answers with a tiny silent WAV, so the phone's playback path runs. */
export const fakeTts: Tts = {
	kind: 'piper',
	about: 'a fake voice',
	async speak() {
		return { mime: 'audio/wav', bytes: silentWav(200) };
	},
	async check() {
		return null;
	}
};

/** A WAV of silence, `ms` long, 8kHz mono 16-bit. */
export function silentWav(ms: number): Uint8Array {
	const rate = 8000;
	const samples = Math.round((rate * ms) / 1000);
	const data = samples * 2;
	const buf = Buffer.alloc(44 + data);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + data, 4);
	buf.write('WAVE', 8);
	buf.write('fmt ', 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(rate, 24);
	buf.writeUInt32LE(rate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36);
	buf.writeUInt32LE(data, 40);
	return new Uint8Array(buf);
}
