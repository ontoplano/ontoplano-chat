/* The model sees this dynamic context and ASSISTANT_INSTRUCTIONS.md on every turn. */
import { readFileSync } from 'node:fs';
import type { McpContext } from './mcp.js';

const assistantInstructions = readFileSync(new URL('../ASSISTANT_INSTRUCTIONS.md', import.meta.url), 'utf8').trim();
export type PromptFacts = {
	name: string;
	language: string;
	/** Today, as the model should write dates: YYYY-MM-DD. */
	today: string;
	/** The local time, HH:MM, and the weekday — so "tomorrow" and "this evening" resolve. */
	time: string;
	weekday: string;
	timezone: string;
	toolCount: number;
	toolNames: string[];
	mcpContext?: McpContext;
};

export function systemPrompt(f: PromptFacts): string {
	const access = f.mcpContext?.access;
	const boundary = access
		? access.kind === 'account'
			? 'The token reaches the account, subject to the tools granted below.'
			: `The token is confined to ${access.label ?? access.kind}${access.id === undefined ? '' : ` (id ${access.id})`}. The server pins references to that boundary; do not ask the person to choose it again.`
		: 'The server did not report this token’s boundary; do not guess it from tool names.';
	return [
		assistantInstructions,
		`You are ${f.name}, a voice assistant for one person's Ontoplano account. You are spoken to and your answers are read aloud.`,
		`Answer in ${f.language}, in one or two short sentences, as speech: no markdown, no lists, no headings, no emoji, no code. Say what you did or found, then stop.`,
		`Now is ${f.weekday} ${f.today} ${f.time} (${f.timezone}). Write dates to tools as YYYY-MM-DD and times as HH:MM; "tomorrow", "tonight" and "next week" are relative to now.`,
		`Access reported by the MCP server: ${boundary}`,
		...(f.mcpContext?.instructions ? [`MCP server instructions: ${f.mcpContext.instructions}`] : []),
		`These ${f.toolCount} tools are available in this round: ${f.toolNames.join(', ') || '(none)'}. Use their schemas. A tool missing from this round does not establish a missing permission; never invent token scope. Never reveal the token value.`,
		`Some tools require confirmation before running. If the person declines, say no change was made.`
	].join('\n');
}

/** The pieces of now a prompt needs, in the server's own timezone. */
export function nowFacts(now: Date, locale: string): Pick<PromptFacts, 'today' | 'time' | 'weekday' | 'timezone'> {
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const pad = (n: number): string => String(n).padStart(2, '0');
	return {
		today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
		time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
		weekday: now.toLocaleDateString(locale, { weekday: 'long' }),
		timezone
	};
}
