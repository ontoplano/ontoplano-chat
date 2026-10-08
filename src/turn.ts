/*
 * One turn of the conversation: hear, think, do, answer, speak.
 *
 * The loop is the ordinary tool-calling loop — the model answers with tool
 * calls, each is made, the results go back, until it answers with words —
 * with two things around it that an assistant acting on somebody's life
 * needs: a gate that stops before anything in the confirm list and asks, and
 * a receipt for every call, written to the log and shown on the phone.
 *
 * Events are emitted as they happen so the phone draws the transcript before
 * the model has thought, and each action as it runs.
 */
import { randomUUID } from 'node:crypto';

import { CONFIRMATION_TTL_MS, CONVERSATION_IDLE_MS, NO_WORDS, TOOL_RESULT_CHARS, YES_WORDS } from './constants.js';
import { confirmQuestion, describeAction } from './describe.js';
import type { ActionRecord, History } from './history.js';
import type { Llm, Message, ToolCall } from './llm.js';
import { matchesAny, toLlmTools, type LlmTool, type McpContext, type McpTool, type ToolResult } from './mcp.js';
import { nowFacts, systemPrompt } from './prompt.js';
import { disabledTelemetry, type Telemetry } from './observability.js';
import type { Stt, Tts } from './speech.js';
import { asksAboutAccess, requestsAction, selectTools } from './tool-selection.js';

export type TurnEvent =
	| { type: 'transcript'; text: string }
	| { type: 'thinking' }
	| {
			type: 'action';
			id: string;
			name: string;
			args: Record<string, unknown>;
			status: 'running' | 'done' | 'failed';
			summary?: string;
			link?: string | null;
	  }
	| { type: 'confirm'; id: string; name: string; args: Record<string, unknown>; question: string }
	| { type: 'reply'; text: string }
	| { type: 'audio'; mime: string; base64: string }
	| { type: 'error'; message: string }
	| { type: 'done' };

export type Emit = (event: TurnEvent) => void;

export type Input = { text?: string; audio?: { bytes: Uint8Array; mime: string }; speak?: boolean };

export type ToolCaller = { call(name: string, args: Record<string, unknown>): Promise<ToolResult> };

export type AssistantOptions = {
	name: string;
	language: string;
	appUrl: string;
	confirm: readonly string[];
	historyTurns: number;
	maxToolRounds: number;
	llm: Llm;
	stt: Stt;
	tts: Tts;
	mcp: ToolCaller;
	/** The tools the model is offered — already filtered and trimmed. */
	tools: () => readonly McpTool[];
	mcpContext?: () => McpContext;
	history: History;
	now?: () => Date;
	/** One line per step of a turn — what was heard, each model call, its thinking, each tool and how it went. */
	log?: (line: string) => void;
	telemetry?: Telemetry;
};

type Pending = {
	id: string;
	call: ToolCall;
	/** The calls after this one in the same model answer, still to run. */
	rest: ToolCall[];
	messages: Message[];
	offered: McpTool[];
	round: number;
	actions: ActionRecord[];
	heard: string;
	expiresAt: number;
};

type Conversation = {
	sessionId: string;
	messages: Message[];
	touchedAt: number;
	pending: Pending | null;
	/** The language the person last spoke in, when the ears detect it; else the configured one. */
	language: string;
};

const LANGUAGE_KEY = (language: string): string => language.toLowerCase().split(/[-_]/)[0] ?? 'en';

export class Assistant {
	private readonly conversations = new Map<string, Conversation>();
	private readonly now: () => Date;

	private readonly log: (line: string) => void;
	private readonly telemetry: Telemetry;

	constructor(private readonly o: AssistantOptions) {
		this.now = o.now ?? (() => new Date());
		this.log = o.log ?? (() => {});
		this.telemetry = o.telemetry ?? disabledTelemetry();
	}

	private conversation(device: string): Conversation {
		const t = this.now().getTime();
		let c = this.conversations.get(device);
		if (!c || t - c.touchedAt > CONVERSATION_IDLE_MS) {
			c = { sessionId: randomUUID(), messages: [], touchedAt: t, pending: null, language: this.o.language };
			this.conversations.set(device, c);
		}
		c.touchedAt = t;
		if (c.pending && c.pending.expiresAt <= t) c.pending = null;
		return c;
	}

	/** A pending question for this device, if one is waiting. */
	pending(device: string): { id: string; question: string } | null {
		const c = this.conversation(device);
		return c.pending ? { id: c.pending.id, question: confirmQuestion(c.pending.call.name, c.pending.call.args) } : null;
	}

	forget(device: string): void {
		this.conversations.delete(device);
	}

	private llmTools(tools: readonly McpTool[]): LlmTool[] {
		return toLlmTools(tools);
	}

	private isOffered(name: string, selected: readonly McpTool[]): boolean {
		return selected.some((t) => t.name === name) && this.o.tools().some((t) => t.name === name);
	}

	private needsConfirmation(name: string): boolean {
		return matchesAny(name, this.o.confirm);
	}

	private system(language: string, tools: readonly McpTool[]): Message {
		const facts = nowFacts(this.now(), this.o.language);
		return {
			role: 'system',
			content: systemPrompt({
				name: this.o.name,
				language,
				toolCount: tools.length,
				toolNames: tools.map((tool) => tool.name),
				mcpContext: this.o.mcpContext?.(),
				...facts
			})
		};
	}

	/** Hear (or read) what was said and carry the turn through. */
	async turn(device: string, input: Input, emit: Emit): Promise<void> {
		const c = this.conversation(device);
		let heard = (input.text ?? '').trim();
		return this.telemetry.run(
			'ontoplano-turn',
			'agent',
			{ sessionId: c.sessionId, input: heard || '[audio]' },
			async (span) => {
				const tracedEmit: Emit = (event) => {
					if (event.type === 'reply') span.update({ output: event.text });
					if (event.type === 'confirm') span.update({ output: { confirmation: event.question, tool: event.name } });
					if (event.type === 'error') span.update({ level: 'ERROR', statusMessage: event.message });
					emit(event);
				};
				try {
					if (input.audio) {
						const said = await this.o.stt.transcribe(input.audio.bytes, input.audio.mime);
						heard = said.text;
						if (said.language) {
							c.language = said.language;
							this.log(`[${device}] language heard: ${said.language}`);
						}
						tracedEmit({ type: 'transcript', text: heard });
						span.update({ input: { sessionId: c.sessionId, input: heard } });
						if (!heard) {
							tracedEmit({ type: 'error', message: 'nothing-heard' });
							tracedEmit({ type: 'done' });
							return;
						}
					}
					this.log(`[${device}] heard: ${heard}`);
					if (!heard) {
						tracedEmit({ type: 'error', message: 'nothing-said' });
						tracedEmit({ type: 'done' });
						return;
					}
					if (c.pending) {
						const answer = yesOrNo(heard, c.language);
						if (answer !== null) return this.resume(device, c.pending.id, answer, tracedEmit, input.speak !== false);
						// Something else was said: the question lapses and the new thing is heard.
						c.pending = null;
					}
					if (asksAboutAccess(heard)) {
						const available = this.o.tools();
						const access = this.o.mcpContext?.().access;
						const examples = available
							.filter((tool) => /notebook|note|entry|task|bill/i.test(tool.name))
							.slice(0, 8)
							.map((tool) => tool.name)
							.join(', ');
						const pt = c.language.toLowerCase().startsWith('pt');
						const boundary = access
							? access.kind === 'account'
								? pt
									? 'O token alcança a conta, dentro das permissões das ferramentas.'
									: 'The token reaches the account, within the granted tool permissions.'
								: pt
									? `O token está limitado a ${access.label ?? access.kind}.`
									: `The token is limited to ${access.label ?? access.kind}.`
							: pt
								? 'O servidor não informou o limite do token.'
								: 'The server did not report the token boundary.';
						const text = pt
							? `Tenho ${available.length} ferramentas disponíveis${examples ? `, incluindo ${examples}` : ''}. ${boundary} Não revelo o valor do token.`
							: `I have ${available.length} tools available${examples ? `, including ${examples}` : ''}. ${boundary} I cannot reveal the token value.`;
						await this.finish(device, c, heard, text, [], tracedEmit, input.speak !== false);
						return;
					}
					const selected = selectTools(heard, this.o.tools());
					const messages: Message[] = [
						this.system(c.language, selected),
						...this.recentContext(c),
						{ role: 'user', content: heard }
					];
					await this.run(device, c, messages, 0, [], heard, tracedEmit, input.speak !== false);
				} catch (e) {
					tracedEmit({ type: 'error', message: (e as Error).message });
					this.o.history.append({
						at: this.now().toISOString(),
						device,
						heard,
						reply: '',
						actions: [],
						error: (e as Error).message
					});
					tracedEmit({ type: 'done' });
				}
			}
		);
	}

	/** Answer a pending "are you sure?" — from a button, or from a yes/no said aloud. */
	async resume(device: string, id: string, yes: boolean, emit: Emit, speak = true): Promise<void> {
		const c = this.conversation(device);
		return this.telemetry.run(
			'ontoplano-confirmation',
			'agent',
			{ sessionId: c.sessionId, confirmationId: id, approved: yes },
			async (span) => {
				const tracedEmit: Emit = (event) => {
					if (event.type === 'reply') span.update({ output: event.text });
					if (event.type === 'error') span.update({ level: 'ERROR', statusMessage: event.message });
					emit(event);
				};
				const p = c.pending;
				if (!p || p.id !== id) {
					tracedEmit({ type: 'error', message: 'nothing-pending' });
					tracedEmit({ type: 'done' });
					return;
				}
				c.pending = null;
				try {
					const messages = [...p.messages];
					const actions = [...p.actions];
					if (yes) {
						const ran = await this.perform(p.call, tracedEmit, p.offered);
						actions.push(ran.record);
						messages.push(ran.message);
					} else {
						actions.push({ name: p.call.name, args: p.call.args, ok: false, summary: 'declined', link: null });
						messages.push({
							role: 'tool',
							tool_call_id: p.call.id,
							content: 'The person declined; this was NOT done.'
						});
					}
					const stopped = await this.runCalls(
						device,
						c,
						p.rest,
						messages,
						p.round,
						actions,
						p.heard,
						tracedEmit,
						p.offered
					);
					if (stopped) return;
					await this.run(device, c, messages, p.round + 1, actions, p.heard, tracedEmit, speak, p.offered);
				} catch (e) {
					tracedEmit({ type: 'error', message: (e as Error).message });
					this.o.history.append({
						at: this.now().toISOString(),
						device,
						heard: p.heard,
						reply: '',
						actions: p.actions,
						error: (e as Error).message
					});
					tracedEmit({ type: 'done' });
				}
			}
		);
	}

	/** The last turns, as the model should see them: no stale tool traffic, just what was said. */
	private recentContext(c: Conversation): Message[] {
		const spoken = c.messages.filter(
			(m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls && m.content)
		);
		return spoken.slice(-this.o.historyTurns * 2);
	}

	/** The loop: ask the model, run what it asks for, until it answers in words. */
	private async run(
		device: string,
		c: Conversation,
		messages: Message[],
		round: number,
		actions: ActionRecord[],
		heard: string,
		emit: Emit,
		speak: boolean,
		offered?: readonly McpTool[]
	): Promise<void> {
		let selected = [...(offered ?? selectTools(heard, this.o.tools()))];
		let retried = false;
		for (let r = round; r <= this.o.maxToolRounds; r++) {
			emit({ type: 'thinking' });
			const final = r === this.o.maxToolRounds;
			const tools = final ? [] : this.llmTools(selected);
			const started = Date.now();
			this.log(`[${device}] model: round ${r + 1}, ${tools.length} tools, ${messages.length} messages`);
			const reply = await this.telemetry.run(
				`model-round-${r + 1}`,
				'generation',
				{ messages, tools },
				async (span) => {
					span.update({ model: this.o.llm.model, metadata: { provider: this.o.llm.provider ?? 'unknown' } });
					const answer = await this.o.llm.chat(messages, tools);
					span.update({
						output: { content: answer.content, toolCalls: answer.toolCalls },
						...(answer.usage
							? { usageDetails: { input: answer.usage.input, output: answer.usage.output, total: answer.usage.total } }
							: {})
					});
					return answer;
				}
			);
			const took = ((Date.now() - started) / 1000).toFixed(1);
			if (reply.thinking) this.log(`[${device}] thinking (${took}s): ${oneLine(reply.thinking, LOG_THINKING_CHARS)}`);
			if (reply.toolCalls.length)
				this.log(
					`[${device}] model wants (${took}s): ${reply.toolCalls.map((t) => `${t.name}(${oneLine(JSON.stringify(t.args), LOG_ARGS_CHARS)})`).join(', ')}`
				);
			else this.log(`[${device}] model says (${took}s): ${oneLine(reply.content, LOG_REPLY_CHARS)}`);
			if (reply.toolCalls.length && !final) {
				messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.raw });
				const stopped = await this.runCalls(device, c, reply.toolCalls, messages, r, actions, heard, emit, selected);
				if (stopped) return;
				continue;
			}
			if (r === 0 && !actions.length && requestsAction(heard) && !final) {
				this.log(`[${device}] model skipped an explicit action; retrying with the full available tool list`);
				messages.push(
					{ role: 'assistant', content: reply.content },
					{
						role: 'system',
						content:
							'The person asked for an action, but you used no tool. Review the complete tool list now. Call the tools needed to fulfill the request, or explain a genuine missing prerequisite. Do not invent a permission denial.'
					}
				);
				selected = [...this.o.tools()];
				messages[0] = this.system(c.language, selected);
				retried = true;
				continue;
			}
			if (retried && !actions.length) {
				const text = c.language.toLowerCase().startsWith('pt')
					? 'Não consegui executar o pedido; nenhuma alteração foi feita.'
					: 'I could not carry out the request; nothing was changed.';
				await this.finish(device, c, heard, text, actions, emit, speak);
				return;
			}
			const text = reply.content || fallbackReply(this.o.language);
			await this.finish(device, c, heard, text, actions, emit, speak);
			return;
		}
	}

	/**
	 * Make each call in turn. Answers true when the turn stopped at a
	 * confirmation — the rest is stashed and the loop is left for `resume`.
	 */
	private async runCalls(
		device: string,
		c: Conversation,
		calls: ToolCall[],
		messages: Message[],
		round: number,
		actions: ActionRecord[],
		heard: string,
		emit: Emit,
		selected: readonly McpTool[]
	): Promise<boolean> {
		for (let i = 0; i < calls.length; i++) {
			const call = calls[i] as ToolCall;
			if (call.name === 'tools/list' && !this.isOffered(call.name, selected)) {
				this.log(`[${device}] model requested MCP discovery; using the offered tool schemas`);
				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					content: `tools/list is an MCP protocol method, not a callable tool. The client already listed the tools. Call one of these offered tools using its schema: ${selected.map((tool) => tool.name).join(', ')}.`
				});
				continue;
			}
			if (this.needsConfirmation(call.name) && this.isOffered(call.name, selected)) {
				const id = randomUUID();
				c.pending = {
					id,
					call,
					rest: calls.slice(i + 1),
					messages: [...messages],
					offered: [...selected],
					round,
					actions: [...actions],
					heard,
					expiresAt: this.now().getTime() + CONFIRMATION_TTL_MS
				};
				const question = confirmQuestion(call.name, call.args);
				emit({ type: 'confirm', id, name: call.name, args: call.args, question });
				this.o.history.append({
					at: this.now().toISOString(),
					device,
					heard,
					reply: '',
					actions: [...actions],
					asked: question
				});
				emit({ type: 'done' });
				return true;
			}
			const ran = await this.perform(call, emit, selected);
			actions.push(ran.record);
			messages.push(ran.message);
		}
		return false;
	}

	/** One call, with its receipt. A tool the model was not offered is refused here, not sent on. */
	private async perform(
		call: ToolCall,
		emit: Emit,
		selected: readonly McpTool[]
	): Promise<{ record: ActionRecord; message: Message }> {
		return this.telemetry.run(call.name, 'tool', { arguments: call.args }, async (span) => {
			emit({ type: 'action', id: call.id, name: call.name, args: call.args, status: 'running' });
			let result: ToolResult;
			if (!this.isOffered(call.name, selected)) {
				result = { ok: false, text: `There is no tool called ${call.name}.`, structured: undefined };
			} else {
				try {
					result = await this.o.mcp.call(call.name, call.args);
				} catch (e) {
					result = { ok: false, text: (e as Error).message, structured: undefined };
				}
			}
			span.update({
				output: result.structured ?? result.text,
				...(result.ok ? {} : { level: 'ERROR' as const, statusMessage: result.text })
			});
			this.log(`  ${result.ok ? '✓' : '✗'} ${call.name}: ${oneLine(result.text, LOG_RESULT_CHARS)}`);
			const receipt = describeAction(this.o.appUrl, call.name, call.args, result);
			emit({
				type: 'action',
				id: call.id,
				name: call.name,
				args: call.args,
				status: result.ok ? 'done' : 'failed',
				summary: receipt.summary,
				link: receipt.link
			});
			const content =
				result.text.length > TOOL_RESULT_CHARS ? result.text.slice(0, TOOL_RESULT_CHARS) + '…' : result.text;
			return {
				record: { name: call.name, args: call.args, ok: result.ok, summary: receipt.summary, link: receipt.link },
				message: { role: 'tool', tool_call_id: call.id, content: result.ok ? content : `Error: ${content}` }
			};
		});
	}

	private async finish(
		device: string,
		c: Conversation,
		heard: string,
		text: string,
		actions: ActionRecord[],
		emit: Emit,
		speak: boolean
	): Promise<void> {
		emit({ type: 'reply', text });
		c.messages.push({ role: 'user', content: heard }, { role: 'assistant', content: text });
		const keep = this.o.historyTurns * 2;
		if (c.messages.length > keep) c.messages.splice(0, c.messages.length - keep);
		this.o.history.append({ at: this.now().toISOString(), device, heard, reply: text, actions });
		if (speak) {
			try {
				const spoken = await this.o.tts.speak(text, c.language.toLowerCase().split(/[-_]/)[0]);
				if (spoken) emit({ type: 'audio', mime: spoken.mime, base64: Buffer.from(spoken.bytes).toString('base64') });
			} catch (e) {
				emit({ type: 'error', message: `voice: ${(e as Error).message}` });
			}
		}
		emit({ type: 'done' });
	}
}

/** "sim", "no", "go ahead": a bare answer in the assistant's language, or null when something else was said. */
const LOG_THINKING_CHARS = 600;
const LOG_ARGS_CHARS = 200;
const LOG_REPLY_CHARS = 300;
const LOG_RESULT_CHARS = 200;
const oneLine = (t: string, n: number): string => {
	const flat = t.replace(/\s+/g, ' ').trim();
	return flat.length > n ? flat.slice(0, n) + '…' : flat;
};

export function yesOrNo(text: string, language: string): boolean | null {
	const key = LANGUAGE_KEY(language);
	const flat = text
		.toLowerCase()
		.replace(/[.,!?;:…]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!flat || flat.split(' ').length > 4) return null;
	const yes = [...(YES_WORDS[key] ?? []), ...YES_WORDS.en!];
	const no = [...(NO_WORDS[key] ?? []), ...NO_WORDS.en!];
	// "no" is checked first: "não, pode deixar" is a no even though "pode" is a yes.
	if (no.some((w) => flat === w || flat.startsWith(w + ' '))) return false;
	if (yes.some((w) => flat === w || flat.startsWith(w + ' '))) return true;
	return null;
}

function fallbackReply(language: string): string {
	return LANGUAGE_KEY(language) === 'pt' ? 'Feito.' : 'Done.';
}
