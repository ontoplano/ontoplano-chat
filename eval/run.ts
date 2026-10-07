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
import { langfuseTelemetry, redact, type Telemetry } from '../src/observability.js';
import { Assistant, type ToolCaller, type TurnEvent } from '../src/turn.js';
import { cases, type EvalCase } from './cases.js';
import { evaluate, failureReasons, type ObservedCall, type Outcome, type Step } from './evaluate.js';

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
const safeText = (value: string): string =>
	String(
		redact(value, [
			process.env.EVAL_MODEL_API_KEY ?? '',
			process.env.LANGFUSE_PUBLIC_KEY ?? '',
			process.env.LANGFUSE_SECRET_KEY ?? ''
		])
	);
function displayUrl(raw: string): string {
	try {
		const url = new URL(raw);
		return safeText(`${url.origin}${url.pathname.replace(/\/$/, '')}`);
	} catch {
		return '(invalid URL)';
	}
}

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

async function runCase(test: EvalCase, llm: Llm, telemetry: Telemetry, onStep: (step: Step) => void): Promise<Row> {
	const dir = mkdtempSync(join(tmpdir(), 'ontoplano-chat-eval-'));
	try {
		const calls: ObservedCall[] = [];
		const steps: Step[] = [];
		let modelRounds = 0;
		const recordStep = (step: Step): void => {
			steps.push(step);
			onStep(step);
		};
		let tokens: Outcome['tokens'];
		const countedLlm: Llm = {
			...llm,
			async chat(messages, offered) {
				const name = `round ${++modelRounds}`;
				const started = performance.now();
				try {
					const reply = await llm.chat(messages, offered);
					if (reply.usage)
						tokens = {
							input: (tokens?.input ?? 0) + reply.usage.input,
							output: (tokens?.output ?? 0) + reply.usage.output,
							total: (tokens?.total ?? 0) + reply.usage.total
						};
					recordStep({
						kind: 'model',
						name,
						durationMs: performance.now() - started,
						detail: reply.toolCalls.length
							? `requested ${reply.toolCalls.map((call) => call.name).join(', ')}`
							: 'final answer'
					});
					return reply;
				} catch (error) {
					recordStep({
						kind: 'model',
						name,
						durationMs: performance.now() - started,
						detail: `failed: ${(error as Error).message}`
					});
					throw error;
				}
			}
		};
		const synthetic = new SyntheticMcp();
		const monitoredMcp: ToolCaller = {
			async call(name, args) {
				const started = performance.now();
				try {
					const result = await synthetic.call(name, args);
					const durationMs = performance.now() - started;
					const call = [...calls].reverse().find((item) => item.name === name && item.durationMs === undefined);
					if (call) call.durationMs = durationMs;
					recordStep({ kind: 'tool', name, durationMs, detail: result.ok ? 'ok' : `failed: ${result.text}` });
					return result;
				} catch (error) {
					recordStep({
						kind: 'tool',
						name,
						durationMs: performance.now() - started,
						detail: `failed: ${(error as Error).message}`
					});
					throw error;
				}
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
			mcp: monitoredMcp,
			tools: () => tools,
			history: new History(dir),
			telemetry
		});
		let answer = '';
		let confirmed = false;
		let error: string | undefined;
		const started = performance.now();
		await assistant.turn(`eval-${test.id}`, { text: test.input }, (event: TurnEvent) => {
			if (event.type === 'action' && event.status === 'running')
				calls.push({ name: event.name, args: event.args, executed: true });
			if (event.type === 'action' && event.status !== 'running') {
				const call = [...calls].reverse().find((item) => item.name === event.name && item.ok === undefined);
				if (call) {
					call.ok = event.status === 'done';
					call.summary = event.summary;
				}
			}
			if (event.type === 'confirm') {
				calls.push({ name: event.name, args: event.args, executed: false });
				confirmed = true;
				answer = event.question;
			}
			if (event.type === 'reply') answer = event.text;
			if (event.type === 'error') {
				error = event.message;
				answer = '';
			}
		});
		const result: Outcome = { calls, answer, confirmed, error, steps, latencyMs: performance.now() - started, tokens };
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
	const modelEndpoint = displayUrl(MODEL_URL);
	const langfuseUrl = process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com';
	console.log(`Model:          ${MODEL_NAME}`);
	console.log(`Model endpoint: ${modelEndpoint} (GET /models, POST /chat/completions)`);
	console.log('Ontoplano MCP: synthetic in memory; no Ontoplano config, token, or server is used');
	console.log(
		`Langfuse:       ${process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY ? `${displayUrl(langfuseUrl)} (${process.argv.includes('--langfuse') ? 'experiment and traces' : 'traces'})` : 'disabled (keys not set)'}`
	);
	console.log(`Cases:          ${cases.length}\n`);
	const llm = openAiLlm({
		url: MODEL_URL.replace(/\/$/, ''),
		model: MODEL_NAME,
		apiKey: process.env.EVAL_MODEL_API_KEY,
		timeoutMs: MODEL_TIMEOUT_MS
	});
	console.log('Checking model availability…');
	const probeStarted = performance.now();
	const problem = await llm.check();
	if (problem)
		throw new Error(
			`Model check failed after ${((performance.now() - probeStarted) / 1000).toFixed(1)}s at ${modelEndpoint}: ${safeText(problem)}`
		);
	console.log(`Model ready in ${((performance.now() - probeStarted) / 1000).toFixed(1)}s\n`);
	const telemetry = langfuseTelemetry(process.env, [process.env.EVAL_MODEL_API_KEY ?? ''].filter(Boolean));
	const rows: Row[] = [];
	const runAndReport = async (test: EvalCase): Promise<Row> => {
		const ordinal = String(cases.findIndex((item) => item.id === test.id) + 1).padStart(
			String(cases.length).length,
			'0'
		);
		console.log(`[${ordinal}/${cases.length}] ${test.id}: ${test.input}`);
		const started = performance.now();
		let row: Row;
		try {
			row = await runCase(test, llm, telemetry, (step) =>
				console.log(`  ${step.kind} ${step.name}: ${(step.durationMs / 1000).toFixed(2)}s — ${safeText(step.detail)}`)
			);
		} catch (error) {
			const result: Outcome = {
				calls: [],
				answer: '',
				confirmed: false,
				error: (error as Error).message,
				latencyMs: performance.now() - started
			};
			row = { id: test.id, result, score: evaluate(test, result, writes) };
		}
		rows.push(row);
		console.log(`  ${row.score.completed ? 'PASS' : 'FAIL'} in ${(row.result.latencyMs / 1000).toFixed(2)}s`);
		if (!row.score.completed) {
			for (const reason of failureReasons(test, row.result, writes)) console.log(`  reason: ${safeText(reason)}`);
			console.log(
				`  observed: ${safeText(row.result.calls.map((call) => `${call.name}(${JSON.stringify(call.args)}) ${call.executed ? (call.ok ? 'ok' : 'failed') : 'awaiting confirmation'}`).join(' → ') || '(no tool calls)')}`
			);
		}
		return row;
	};
	try {
		if (process.argv.includes('--langfuse')) {
			if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY)
				throw new Error('--langfuse requires Langfuse keys');
			const client = new LangfuseClient();
			await client.experiment.run({
				name: `ontoplano-chat ${MODEL_NAME}`,
				data: cases.map((test) => ({ input: test })),
				maxConcurrency: 1,
				task: async ({ input }) => runAndReport(input as EvalCase),
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
			for (const test of cases) await runAndReport(test);
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
		const total = measured.reduce((sum, row) => sum + row.result.tokens!.total, 0);
		console.log(`Total tokens:                ${total} (${measured.length}/${rows.length} cases reported usage)`);
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
	console.error(safeText((error as Error).message));
	process.exitCode = 1;
});
