import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LangfuseClient } from '@langfuse/client';

import { DEFAULT_CONFIRM } from '../src/constants.js';
import { fakeStt, fakeTts } from '../src/fakes.js';
import { History } from '../src/history.js';
import { openAiLlm, type Llm } from '../src/llm.js';
import { type McpTool, type ToolResult } from '../src/mcp.js';
import { langfuseTelemetry, type Telemetry } from '../src/observability.js';
import { Assistant, type ToolCaller, type TurnEvent } from '../src/turn.js';
import { cases, type EvalCase } from './cases.js';
import { evaluate, type ObservedCall, type Outcome } from './evaluate.js';

type EvalTool = McpTool & { writes: boolean; destroys: boolean };
const tools = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tools.json'), 'utf8')
) as EvalTool[];
const names = new Set(tools.map((tool) => tool.name));
const writes = new Set(tools.filter((tool) => tool.writes).map((tool) => tool.name));
const MODEL_URL = process.env.EVAL_MODEL_URL ?? 'http://127.0.0.1:11434/v1';
const MODEL_NAME = process.env.EVAL_MODEL_NAME ?? 'qwen3.5:9b';
const MODEL_TIMEOUT_MS = 120_000;
const MODEL_MAX_ROUNDS = 6;
const HISTORY_TURNS = 4;
type Row = { id: string; score: ReturnType<typeof evaluate>; result: Outcome };

function validate(): void {
	if (cases.length < 20 || cases.length > 30) throw new Error('Expected 20–30 evaluation cases');
	for (const test of cases) {
		for (const expected of test.expected)
			if (!names.has(expected.name)) throw new Error(`${test.id}: unknown ${expected.name}`);
		for (const forbidden of test.forbidden ?? [])
			if (!names.has(forbidden)) throw new Error(`${test.id}: unknown ${forbidden}`);
		if (test.confirmation && !test.expected.some((call) => tools.find((tool) => tool.name === call.name)?.destroys))
			throw new Error(`${test.id}: confirmation case has no destructive tool`);
	}
}

/** Only synthetic rows. The runner never loads an Ontoplano config or creates an HTTP MCP client. */
class SyntheticMcp implements ToolCaller {
	private nextId = 20;
	async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		const ok = (value: unknown): ToolResult => ({ ok: true, text: JSON.stringify(value), structured: value });
		if (name === 'finish_task' && args.id === 999999) return { ok: false, text: 'no such task', structured: undefined };
		if (writes.has(name))
			return ok({ id: typeof args.id === 'number' ? args.id : ++this.nextId, name, changed: true, ...args });
		switch (name) {
			case 'today':
				return ok({
					date: '2026-10-07',
					blocks: [{ id: 'slot:9', title: 'exercise', start: '18:00' }],
					tasks: [{ id: 1, title: 'buy milk' }]
				});
			case 'tasks':
				return ok({
					items: [
						{ id: 1, title: 'buy milk', status: 'todo' },
						{ id: 2, title: 'call the plumber', status: 'todo' }
					]
				});
			case 'upcoming':
				return ok({ blocks: [{ id: 'slot:9', title: 'exercise', date: '2026-10-08', start: '18:00' }] });
			case 'repeating_week':
				return ok({ blocks: [{ id: 9, title: 'exercise', weekday: 3, start_time: '18:00' }] });
			case 'goals':
				return ok({ goals: [{ id: 4, title: 'run 100 km', horizon: 'quarter' }] });
			case 'workouts':
				return ok({ workouts: [{ id: 3, name: 'strength training' }] });
			case 'shopping_list':
				return ok({ items: [{ id: 5, name: 'rice', bought: false }] });
			case 'notebooks':
				return ok({ notebooks: [{ id: 7, title: 'Kitchen' }] });
			case 'notebook_notes':
				return ok({ notes: [{ id: 8, title: 'Tap', content: 'The tap needs replacing.' }] });
			case 'search':
				return ok({ results: [{ kind: 'note', title: 'Kitchen tap', id: 8 }] });
			default:
				return ok({ items: [] });
		}
	}
}

async function runCase(test: EvalCase, llm: Llm, telemetry: Telemetry): Promise<Row> {
	const dir = mkdtempSync(join(tmpdir(), 'ontoplano-chat-eval-'));
	try {
		const calls: ObservedCall[] = [];
		let tokens: Outcome['tokens'];
		const countedLlm: Llm = {
			...llm,
			async chat(messages, offered) {
				const reply = await llm.chat(messages, offered);
				if (reply.usage)
					tokens = {
						input: (tokens?.input ?? 0) + reply.usage.input,
						output: (tokens?.output ?? 0) + reply.usage.output,
						total: (tokens?.total ?? 0) + reply.usage.total
					};
				return reply;
			}
		};
		const assistant = new Assistant({
			name: 'Ontoplano',
			language: 'en',
			appUrl: 'http://synthetic.invalid',
			confirm: DEFAULT_CONFIRM,
			historyTurns: HISTORY_TURNS,
			maxToolRounds: MODEL_MAX_ROUNDS,
			llm: countedLlm,
			stt: fakeStt,
			tts: fakeTts,
			mcp: new SyntheticMcp(),
			tools: () => tools,
			history: new History(dir),
			telemetry
		});
		let answer = '';
		let confirmed = false;
		const started = performance.now();
		await assistant.turn(`eval-${test.id}`, { text: test.input }, (event: TurnEvent) => {
			if (event.type === 'action' && event.status === 'running')
				calls.push({ name: event.name, args: event.args, executed: true });
			if (event.type === 'action' && event.status !== 'running') {
				const call = [...calls].reverse().find((item) => item.name === event.name && item.ok === undefined);
				if (call) call.ok = event.status === 'done';
			}
			if (event.type === 'confirm') {
				calls.push({ name: event.name, args: event.args, executed: false });
				confirmed = true;
				answer = event.question;
			}
			if (event.type === 'reply') answer = event.text;
			if (event.type === 'error') answer = `Error: ${event.message}`;
		});
		const result: Outcome = { calls, answer, confirmed, latencyMs: performance.now() - started, tokens };
		const score = evaluate(test, result, writes);
		return { id: test.id, score, result };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	validate();
	if (process.argv.includes('--check')) {
		console.log(
			`Validated ${cases.length} cases and ${tools.length} real MCP tool definitions; no model or app contacted.`
		);
		return;
	}
	const url = new URL(MODEL_URL);
	if (!['http:', 'https:'].includes(url.protocol)) throw new Error('EVAL_MODEL_URL must be HTTP(S)');
	if (url.username || url.password) throw new Error('EVAL_MODEL_URL must not contain credentials');
	const llm = openAiLlm({
		url: MODEL_URL.replace(/\/$/, ''),
		model: MODEL_NAME,
		apiKey: process.env.EVAL_MODEL_API_KEY,
		timeoutMs: MODEL_TIMEOUT_MS
	});
	const problem = await llm.check();
	if (problem) throw new Error(`Evaluation model unavailable: ${problem}`);
	const telemetry = langfuseTelemetry(process.env, [process.env.EVAL_MODEL_API_KEY ?? ''].filter(Boolean));
	const rows: Row[] = [];
	try {
		if (process.argv.includes('--langfuse')) {
			if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY)
				throw new Error('--langfuse requires Langfuse keys');
			const client = new LangfuseClient();
			await client.experiment.run({
				name: `ontoplano-chat ${MODEL_NAME}`,
				data: cases.map((test) => ({ input: test })),
				maxConcurrency: 1,
				task: async ({ input }) => {
					const row = await runCase(input as EvalCase, llm, telemetry);
					rows.push(row);
					console.log(`${row.score.completed ? 'PASS' : 'FAIL'} ${row.id}`);
					return row;
				},
				evaluators: [
					async ({ output }) => {
						const score = (output as Row).score;
						return [
							{ name: 'task_completion', value: Number(score.completed) },
							{ name: 'tool_selection', value: Number(score.selected) },
							{ name: 'unsafe_mutation', value: Number(score.unsafe) },
							...(score.argumentsCorrect === null
								? []
								: [{ name: 'arguments_correct', value: Number(score.argumentsCorrect) }])
						];
					}
				]
			});
		} else {
			for (const test of cases) {
				const row = await runCase(test, llm, telemetry);
				rows.push(row);
				console.log(
					`${row.score.completed ? 'PASS' : 'FAIL'} ${row.id}${row.score.unsafe ? ' (unsafe mutation)' : ''}`
				);
			}
		}
	} finally {
		await telemetry.shutdown();
	}
	const percent = (count: number, total: number): string => `${((100 * count) / total).toFixed(1)}%`;
	const argumentRows = rows.filter((row) => row.score.argumentsCorrect !== null);
	console.log(`\nCases:                       ${rows.length}`);
	console.log(`Task completion:             ${percent(rows.filter((row) => row.score.completed).length, rows.length)}`);
	console.log(`Tool selection accuracy:     ${percent(rows.filter((row) => row.score.selected).length, rows.length)}`);
	console.log(
		`Tool argument correctness:   ${percent(argumentRows.filter((row) => row.score.argumentsCorrect).length, argumentRows.length)}`
	);
	console.log(`Unsafe mutation rate:        ${percent(rows.filter((row) => row.score.unsafe).length, rows.length)}`);
	console.log(
		`Average latency:             ${(rows.reduce((sum, row) => sum + row.result.latencyMs, 0) / rows.length / 1000).toFixed(2)}s`
	);
	const measured = rows.filter((row) => row.result.tokens);
	if (measured.length) {
		const input = measured.reduce((sum, row) => sum + row.result.tokens!.input, 0);
		const output = measured.reduce((sum, row) => sum + row.result.tokens!.output, 0);
		console.log(
			`Total tokens:                ${input + output} (${measured.length}/${rows.length} cases reported usage)`
		);
		const inputPrice = Number(process.env.EVAL_INPUT_USD_PER_MILLION);
		const outputPrice = Number(process.env.EVAL_OUTPUT_USD_PER_MILLION);
		if (inputPrice > 0 && outputPrice > 0)
			console.log(
				`Estimated cost:              $${((input * inputPrice + output * outputPrice) / 1_000_000).toFixed(4)}`
			);
	}
	if (rows.some((row) => !row.score.completed)) process.exitCode = 1;
}

main().catch((error: unknown) => {
	console.error((error as Error).message);
	process.exitCode = 1;
});
