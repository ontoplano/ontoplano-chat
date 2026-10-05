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
import { matchesAny, toLlmTools, type LlmTool, type McpTool, type ToolResult } from './mcp.js';
import { nowFacts, systemPrompt } from './prompt.js';
import type { Stt, Tts } from './speech.js';

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
	| { type: 'confirm'; id: string; name: string; question: string }
	| { type: 'reply'; text: string }
	| { type: 'audio'; mime: string; base64: string }
	| { type: 'error'; message: string }
	| { type: 'done' };

export type Emit = (event: TurnEvent) => void;

export type Input = { text?: string; audio?: { bytes: Uint8Array; mime: string } };

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
	history: History;
	now?: () => Date;
	/** One line per step of a turn — what was heard, each model call, its thinking, each tool and how it went. */
	log?: (line: string) => void;
};

type Pending = {
	id: string;
	call: ToolCall;
	/** The calls after this one in the same model answer, still to run. */
	rest: ToolCall[];
	messages: Message[];
	round: number;
	actions: ActionRecord[];
	heard: string;
	expiresAt: number;
};

type Conversation = { messages: Message[]; touchedAt: number; pending: Pending | null };

const LANGUAGE_KEY = (language: string): string => language.toLowerCase().split(/[-_]/)[0] ?? 'en';

export class Assistant {
	private readonly conversations = new Map<string, Conversation>();
	private readonly now: () => Date;

	private readonly log: (line: string) => void;

	constructor(private readonly o: AssistantOptions) {
		this.now = o.now ?? (() => new Date());
		this.log = o.log ?? (() => {});
	}

	private conversation(device: string): Conversation {
		const t = this.now().getTime();
		let c = this.conversations.get(device);
		if (!c || t - c.touchedAt > CONVERSATION_IDLE_MS) {
			c = { messages: [], touchedAt: t, pending: null };
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

	private llmTools(): LlmTool[] {
		return toLlmTools(this.o.tools());
	}

	private isOffered(name: string): boolean {
		return this.o.tools().some((t) => t.name === name);
	}

	private needsConfirmation(name: string): boolean {
		return matchesAny(name, this.o.confirm);
	}

	private system(): Message {
		const facts = nowFacts(this.now(), this.o.language);
		return {
			role: 'system',
			content: systemPrompt({
				name: this.o.name,
				language: this.o.language,
				toolCount: this.o.tools().length,
				...facts
			})
		};
	}

	/** Hear (or read) what was said and carry the turn through. */
	async turn(device: string, input: Input, emit: Emit): Promise<void> {
		const c = this.conversation(device);
		let heard = (input.text ?? '').trim();
		try {
			if (input.audio) {
				heard = (await this.o.stt.transcribe(input.audio.bytes, input.audio.mime)).trim();
				emit({ type: 'transcript', text: heard });
				if (!heard) {
					emit({ type: 'error', message: 'nothing-heard' });
					emit({ type: 'done' });
					return;
				}
			}
			this.log(`[${device}] heard: ${heard}`);
			if (!heard) {
				emit({ type: 'error', message: 'nothing-said' });
				emit({ type: 'done' });
				return;
			}
			if (c.pending) {
				const answer = yesOrNo(heard, this.o.language);
				if (answer !== null) return this.resume(device, c.pending.id, answer, emit);
				// Something else was said: the question lapses and the new thing is heard.
				c.pending = null;
			}
			const messages: Message[] = [this.system(), ...this.recentContext(c), { role: 'user', content: heard }];
			await this.run(device, c, messages, 0, [], heard, emit);
		} catch (e) {
			emit({ type: 'error', message: (e as Error).message });
			this.o.history.append({
				at: this.now().toISOString(),
				device,
				heard,
				reply: '',
				actions: [],
				error: (e as Error).message
			});
			emit({ type: 'done' });
		}
	}

	/** Answer a pending "are you sure?" — from a button, or from a yes/no said aloud. */
	async resume(device: string, id: string, yes: boolean, emit: Emit): Promise<void> {
		const c = this.conversation(device);
		const p = c.pending;
		if (!p || p.id !== id) {
			emit({ type: 'error', message: 'nothing-pending' });
			emit({ type: 'done' });
			return;
		}
		c.pending = null;
		try {
			const messages = [...p.messages];
			const actions = [...p.actions];
			if (yes) {
				const ran = await this.perform(p.call, emit);
				actions.push(ran.record);
				messages.push(ran.message);
			} else {
				actions.push({ name: p.call.name, args: p.call.args, ok: false, summary: 'declined', link: null });
				messages.push({ role: 'tool', tool_call_id: p.call.id, content: 'The person declined; this was NOT done.' });
			}
			const stopped = await this.runCalls(device, c, p.rest, messages, p.round, actions, p.heard, emit);
			if (stopped) return;
			await this.run(device, c, messages, p.round + 1, actions, p.heard, emit);
		} catch (e) {
			emit({ type: 'error', message: (e as Error).message });
			this.o.history.append({
				at: this.now().toISOString(),
				device,
				heard: p.heard,
				reply: '',
				actions: p.actions,
				error: (e as Error).message
			});
			emit({ type: 'done' });
		}
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
		emit: Emit
	): Promise<void> {
		for (let r = round; r <= this.o.maxToolRounds; r++) {
			emit({ type: 'thinking' });
			const final = r === this.o.maxToolRounds;
			const tools = final ? [] : this.llmTools();
			const started = Date.now();
			this.log(`[${device}] model: round ${r + 1}, ${tools.length} tools, ${messages.length} messages`);
			const reply = await this.o.llm.chat(messages, tools);
			const took = ((Date.now() - started) / 1000).toFixed(1);
			if (reply.thinking) this.log(`[${device}] thinking (${took}s): ${oneLine(reply.thinking, LOG_THINKING_CHARS)}`);
			if (reply.toolCalls.length)
				this.log(
					`[${device}] model wants (${took}s): ${reply.toolCalls.map((t) => `${t.name}(${oneLine(JSON.stringify(t.args), LOG_ARGS_CHARS)})`).join(', ')}`
				);
			else this.log(`[${device}] model says (${took}s): ${oneLine(reply.content, LOG_REPLY_CHARS)}`);
			if (reply.toolCalls.length && !final) {
				messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.raw });
				const stopped = await this.runCalls(device, c, reply.toolCalls, messages, r, actions, heard, emit);
				if (stopped) return;
				continue;
			}
			const text = reply.content || fallbackReply(this.o.language);
			await this.finish(device, c, heard, text, actions, emit);
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
		emit: Emit
	): Promise<boolean> {
		for (let i = 0; i < calls.length; i++) {
			const call = calls[i] as ToolCall;
			if (this.needsConfirmation(call.name) && this.isOffered(call.name)) {
				const id = randomUUID();
				c.pending = {
					id,
					call,
					rest: calls.slice(i + 1),
					messages: [...messages],
					round,
					actions: [...actions],
					heard,
					expiresAt: this.now().getTime() + CONFIRMATION_TTL_MS
				};
				const question = confirmQuestion(call.name, call.args);
				emit({ type: 'confirm', id, name: call.name, question });
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
			const ran = await this.perform(call, emit);
			actions.push(ran.record);
			messages.push(ran.message);
		}
		return false;
	}

	/** One call, with its receipt. A tool the model was not offered is refused here, not sent on. */
	private async perform(call: ToolCall, emit: Emit): Promise<{ record: ActionRecord; message: Message }> {
		emit({ type: 'action', id: call.id, name: call.name, args: call.args, status: 'running' });
		let result: ToolResult;
		if (!this.isOffered(call.name)) {
			result = { ok: false, text: `There is no tool called ${call.name}.`, structured: undefined };
		} else {
			try {
				result = await this.o.mcp.call(call.name, call.args);
			} catch (e) {
				result = { ok: false, text: (e as Error).message, structured: undefined };
			}
		}
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
	}

	private async finish(
		device: string,
		c: Conversation,
		heard: string,
		text: string,
		actions: ActionRecord[],
		emit: Emit
	): Promise<void> {
		emit({ type: 'reply', text });
		c.messages.push({ role: 'user', content: heard }, { role: 'assistant', content: text });
		const keep = this.o.historyTurns * 2;
		if (c.messages.length > keep) c.messages.splice(0, c.messages.length - keep);
		this.o.history.append({ at: this.now().toISOString(), device, heard, reply: text, actions });
		try {
			const spoken = await this.o.tts.speak(text);
			if (spoken) emit({ type: 'audio', mime: spoken.mime, base64: Buffer.from(spoken.bytes).toString('base64') });
		} catch (e) {
			emit({ type: 'error', message: `voice: ${(e as Error).message}` });
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
