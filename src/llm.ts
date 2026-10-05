/*
 * The model, through the one API every local runner speaks: OpenAI-style
 * chat completions with tools. Ollama, llama.cpp's server, LM Studio and
 * vLLM all answer this; the config only says where.
 */
import type { LlmTool } from './mcp.js';

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type Message =
	| { role: 'system'; content: string }
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: RawToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string };

type RawToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export type Reply = { content: string; toolCalls: ToolCall[]; raw: RawToolCall[] };

export type Llm = {
	/** One completion. With tool calls, `content` is usually empty. */
	chat(messages: Message[], tools: LlmTool[]): Promise<Reply>;
	/** Is the model there? `null` when all is well, else what is wrong. */
	check(): Promise<string | null>;
	/** Ask the runner to download the model (Ollama's /api/pull). `null` when it did, else why not. */
	pull(): Promise<string | null>;
	readonly model: string;
};

export class LlmError extends Error {}

/** How long the one-token probe may take: a cold model loads first. */
const PROBE_TIMEOUT_MS = 120 * 1000;

/** The message out of an error body, when it is the usual JSON; else the first line of it. */
function firstLine(text: string): string {
	try {
		const parsed = JSON.parse(text) as { error?: { message?: string } | string };
		const e = parsed.error;
		if (typeof e === 'string') return e;
		if (e && typeof e.message === 'string') return e.message;
	} catch {
		// not JSON
	}
	return text.split('\n')[0]?.slice(0, 200) ?? '';
}

export type LlmOptions = {
	url: string;
	model: string;
	apiKey?: string;
	temperature?: number;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
};

export function openAiLlm(o: LlmOptions): Llm {
	const fetchImpl = o.fetchImpl ?? fetch;
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;
	return {
		model: o.model,
		async chat(messages, tools) {
			const signal = AbortSignal.timeout(o.timeoutMs);
			let res: Response;
			try {
				res = await fetchImpl(`${o.url}/chat/completions`, {
					method: 'POST',
					headers,
					signal,
					body: JSON.stringify({
						model: o.model,
						messages,
						tools: tools.length ? tools : undefined,
						temperature: o.temperature ?? 0.2,
						stream: false
					})
				});
			} catch (e) {
				throw new LlmError(
					signal.aborted
						? `the model took longer than ${Math.round(o.timeoutMs / 1000)}s`
						: `no model at ${o.url}: ${(e as Error).message}`
				);
			}
			if (!res.ok) throw new LlmError(`the model answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
			const body = (await res.json()) as {
				choices?: { message?: { content?: string | null; tool_calls?: RawToolCall[] } }[];
			};
			const message = body.choices?.[0]?.message;
			if (!message) throw new LlmError('the model answered with no choices');
			const raw = (message.tool_calls ?? []).map((c, i) => ({
				id: c.id || `call_${i}`,
				type: 'function' as const,
				function: { name: c.function.name, arguments: c.function.arguments ?? '{}' }
			}));
			return {
				content: (message.content ?? '').trim(),
				raw,
				toolCalls: raw.map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }))
			};
		},
		async pull() {
			// Ollama's own API sits beside its OpenAI-compatible one: …/v1 → …/api/pull.
			const base = o.url.replace(/\/v1$/, '');
			try {
				const res = await fetchImpl(`${base}/api/pull`, {
					method: 'POST',
					headers,
					signal: AbortSignal.timeout(60 * 60 * 1000),
					body: JSON.stringify({ model: o.model, stream: false })
				});
				if (res.status === 404)
					return `the runner at ${o.url} does not pull models over its API; install ${o.model} there yourself`;
				if (!res.ok) return `the runner answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
				const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
				return body.error ? `the runner said: ${body.error}` : null;
			} catch (e) {
				return `could not ask ${o.url} to pull it: ${(e as Error).message}`;
			}
		},
		async check() {
			try {
				const res = await fetchImpl(`${o.url}/models`, { headers, signal: AbortSignal.timeout(5000) });
				if (!res.ok) return `${o.url}/models answered ${res.status}`;
				const body = (await res.json()) as { data?: { id: string }[] };
				// A local runner that lists its models — Ollama does — and does not list
				// this one has not pulled it; an empty list is the usual way that looks.
				// A provider behind a key names its models its own way (Gemini says
				// models/…), so only the keyless, local case is read that strictly.
				if (!o.apiKey && Array.isArray(body.data)) {
					const ids = body.data.map((m) => m.id);
					if (!ids.some((id) => id === o.model || id.startsWith(`${o.model}:`)))
						return `model "${o.model}" is not pulled: the runner lists ${ids.length ? ids.slice(0, 5).join(', ') : 'no models'}`;
				}
			} catch (e) {
				return `no model runner at ${o.url}: ${(e as Error).message}`;
			}
			// The list is what the runner says; a one-token completion is what a
			// turn does. Only the second is the truth, so it is asked too.
			try {
				const res = await fetchImpl(`${o.url}/chat/completions`, {
					method: 'POST',
					headers,
					signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
					body: JSON.stringify({
						model: o.model,
						messages: [{ role: 'user', content: 'hi' }],
						max_tokens: 1,
						stream: false
					})
				});
				if (res.status === 404) return `model "${o.model}" is not pulled: ${firstLine(await res.text())}`;
				if (!res.ok) return `the model answered ${res.status} to a one-word question: ${firstLine(await res.text())}`;
				return null;
			} catch (e) {
				return `the model did not answer a one-word question: ${(e as Error).message}`;
			}
		}
	};
}

/** The arguments a model wrote. A model that writes bad JSON gets an empty object rather than a crash. */
export function parseArgs(text: string | Record<string, unknown>): Record<string, unknown> {
	if (text && typeof text === 'object') return text;
	try {
		const parsed = JSON.parse(text || '{}') as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
