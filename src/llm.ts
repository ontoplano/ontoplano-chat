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
	readonly model: string;
};

export class LlmError extends Error {}

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
		async check() {
			try {
				const res = await fetchImpl(`${o.url}/models`, { headers, signal: AbortSignal.timeout(5000) });
				if (!res.ok) return `${o.url}/models answered ${res.status}`;
				const body = (await res.json()) as { data?: { id: string }[] };
				const ids = (body.data ?? []).map((m) => m.id);
				if (ids.length && !ids.some((id) => id === o.model || id.startsWith(`${o.model}:`)))
					return `model "${o.model}" is not among the ${ids.length} the runner lists (${ids.slice(0, 5).join(', ')}…)`;
				return null;
			} catch (e) {
				return `no model runner at ${o.url}: ${(e as Error).message}`;
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
