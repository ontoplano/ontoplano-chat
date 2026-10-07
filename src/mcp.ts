/*
 * The app, reached the way any assistant reaches it: MCP over HTTP.
 *
 * ontoplano answers one JSON-RPC message per POST with a JSON body — no
 * session, no event stream — so this client is a `fetch` and a parser. It
 * also reads an event-stream answer, because another MCP server fronting the
 * same tools might send one, and the parser is a dozen lines.
 *
 * The token is the account. It is held here and nowhere else: never in a
 * log, never in an answer to the phone.
 */
import { MCP_CLIENT_INFO, MCP_PATH, MCP_PROTOCOL_VERSION, MCP_REQUEST_TIMEOUT_MS } from './constants.js';

export type McpTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

export type ToolResult = {
	ok: boolean;
	/** What the tool said, as text — JSON from ontoplano. */
	text: string;
	/** The same, parsed, when it parses. */
	structured: unknown;
};

export type McpContext = {
	instructions: string;
	access: { kind: string; id?: number; label?: string } | null;
};

/** The shape an OpenAI-compatible model takes a tool in. */
export type LlmTool = {
	type: 'function';
	function: { name: string; description: string; parameters: Record<string, unknown> };
};

export class McpError extends Error {
	constructor(
		message: string,
		public readonly code?: number
	) {
		super(message);
	}
}

type Rpc = { jsonrpc: '2.0'; id?: number; result?: unknown; error?: { code: number; message: string } };

export class OntoplanoMcp {
	private nextId = 1;
	private initialized = false;
	private serverContext: McpContext = { instructions: '', access: null };

	constructor(
		private readonly appUrl: string,
		private readonly token: string,
		private readonly fetchImpl: typeof fetch = fetch
	) {}

	get endpoint(): string {
		return `${this.appUrl}${MCP_PATH}`;
	}

	get context(): McpContext {
		return this.serverContext;
	}

	private async rpc(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		const res = await this.fetchImpl(this.endpoint, {
			method: 'POST',
			signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				Authorization: `Bearer ${this.token}`
			},
			body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
		});
		if (res.status === 401 || res.status === 403)
			throw new McpError(`the app refused the token (${res.status}); check ontoplano.token and its scopes`, res.status);
		if (!res.ok) throw new McpError(`the app answered ${res.status} to ${method}`, res.status);
		const type = res.headers.get('content-type') ?? '';
		const text = await res.text();
		const message = type.includes('text/event-stream') ? fromEventStream(text, id) : (JSON.parse(text) as Rpc);
		if (!message) throw new McpError(`no answer to ${method} in the app's response`);
		if (message.error) throw new McpError(message.error.message, message.error.code);
		return message.result;
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		const result = (await this.rpc('initialize', {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: MCP_CLIENT_INFO
		})) as { instructions?: unknown; _access?: unknown } | null;
		const access = result?._access;
		this.serverContext = {
			instructions: typeof result?.instructions === 'string' ? result.instructions : '',
			access:
				access && typeof access === 'object' && 'kind' in access && typeof access.kind === 'string'
					? {
							kind: access.kind,
							...('id' in access && typeof access.id === 'number' ? { id: access.id } : {}),
							...('label' in access && typeof access.label === 'string' ? { label: access.label } : {})
						}
					: null
		};
		this.initialized = true;
	}

	/** Every tool the token grants. */
	async listTools(): Promise<McpTool[]> {
		await this.initialize();
		const result = (await this.rpc('tools/list', {})) as { tools?: McpTool[] };
		return (result.tools ?? []).map((t) => ({
			name: t.name,
			description: t.description ?? '',
			inputSchema: t.inputSchema ?? { type: 'object', properties: {} }
		}));
	}

	/** One call. A tool's own refusal comes back as `ok: false` with its words, not as a throw. */
	async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		await this.initialize();
		const result = (await this.rpc('tools/call', { name, arguments: args })) as {
			content?: { type: string; text?: string }[];
			isError?: boolean;
			structuredContent?: unknown;
		};
		const text = (result.content ?? [])
			.filter((c) => c.type === 'text' && typeof c.text === 'string')
			.map((c) => c.text as string)
			.join('\n');
		let structured: unknown = result.structuredContent;
		if (structured === undefined) {
			try {
				structured = JSON.parse(text);
			} catch {
				structured = undefined;
			}
		}
		return { ok: !result.isError, text, structured };
	}
}

/** The message with this id out of an event stream, or null. */
function fromEventStream(text: string, id: number): Rpc | null {
	for (const block of text.split(/\n\n+/)) {
		const data = block
			.split('\n')
			.filter((l) => l.startsWith('data:'))
			.map((l) => l.slice(5).trim())
			.join('\n');
		if (!data) continue;
		try {
			const parsed = JSON.parse(data) as Rpc | Rpc[];
			const list = Array.isArray(parsed) ? parsed : [parsed];
			const hit = list.find((m) => m.id === id);
			if (hit) return hit;
		} catch {
			// not JSON — a comment or a keepalive
		}
	}
	return null;
}

/** Does a name match one of the patterns? `*` is the only wildcard; `["*"]` matches everything. */
export function matchesAny(name: string, patterns: readonly string[]): boolean {
	return patterns.some((p) => {
		if (p === '*') return true;
		if (!p.includes('*')) return p === name;
		const re = new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '$');
		return re.test(name);
	});
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The tools the model is offered: the allowed ones, in the order the config
 * names them (so the everyday ones come first), with descriptions cut to a
 * length a small model reads rather than drowns in. The cut lands on a
 * sentence end where one is near.
 */
export function offeredTools(all: McpTool[], allow: readonly string[], descriptionChars: number): McpTool[] {
	const byName = new Map(all.map((t) => [t.name, t]));
	const chosen: McpTool[] = [];
	const seen = new Set<string>();
	for (const pattern of allow) {
		const matches = pattern.includes('*')
			? all.filter((t) => matchesAny(t.name, [pattern]))
			: byName.has(pattern)
				? [byName.get(pattern) as McpTool]
				: [];
		for (const t of matches) {
			if (seen.has(t.name)) continue;
			seen.add(t.name);
			chosen.push({ ...t, description: trimDescription(t.description, descriptionChars) });
		}
	}
	return chosen;
}

export function trimDescription(text: string, chars: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat.length <= chars) return flat;
	const cut = flat.slice(0, chars);
	// The last full stop in the cut that really ends a sentence — followed by a space, or the end.
	for (let i = cut.length - 1; i >= chars / 2; i--) {
		if (cut[i] === '.' && (i + 1 >= flat.length || flat[i + 1] === ' ')) return cut.slice(0, i + 1);
	}
	return cut.trimEnd() + '…';
}

export function toLlmTools(tools: readonly McpTool[]): LlmTool[] {
	return tools.map((t) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: stripSchema(t.inputSchema)
		}
	}));
}

/** JSON schema the way a chat model's tool API wants it: no `$schema`, no `additionalProperties: false` surprises, deprecated fields gone. */
function stripSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { type: 'object', properties: {} };
	const props = schema.properties;
	if (props && typeof props === 'object') {
		const kept: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
			if (v && typeof v === 'object' && (v as { deprecated?: boolean }).deprecated) continue;
			kept[k] = v;
		}
		out.properties = kept;
	}
	if (Array.isArray(schema.required)) {
		const required = (schema.required as string[]).filter((r) => r in (out.properties as object));
		if (required.length) out.required = required;
	}
	return out;
}
