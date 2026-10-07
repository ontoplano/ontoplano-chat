import type { McpTool } from './mcp.js';

/** Small local models lose track of a 95-tool schema dump. Keep the authorized
 * list intact, but show the model the tools related to this request. */
const MAX_TOOLS_PER_TURN = 28;
const TOPICS: { ask: RegExp; tool: RegExp }[] = [
	{
		ask: /\b(notebook|caderno|nota|note|di[aá]rio|diary|entry|anota)/i,
		tool: /notebook|note|entry|diary|idea|search/i
	},
	{
		ask: /\b(task|todo|tarefa|atividade|agenda|calendar|calend[aá]rio|schedule|marcar)/i,
		tool: /task|today|upcoming|block|search/i
	},
	{ ask: /\b(bill|invoice|payment|conta|fatura|boleto|pagamento)/i, tool: /bill|payment/i },
	{ ask: /\b(goal|meta|progress|progresso)/i, tool: /goal|progress/i },
	{ ask: /\b(workout|treino|exerc[ií]cio)/i, tool: /workout/i },
	{ ask: /\b(shopping|compras?|mercado|inventory|invent[aá]rio)/i, tool: /shopping|inventory|bought/i },
	{ ask: /\b(habit|h[aá]bito)/i, tool: /habit/i },
	{ ask: /\b(today|hoje|amanh[aã]|tomorrow|week|semana)/i, tool: /today|upcoming|task|block|repeating/i }
];

export function selectTools(request: string, all: readonly McpTool[]): McpTool[] {
	if (all.length <= MAX_TOOLS_PER_TURN) return [...all];
	const relevant = TOPICS.filter((topic) => topic.ask.test(request));
	const chosen = relevant.length
		? all.filter((tool) => relevant.some((topic) => topic.tool.test(tool.name)))
		: all.slice(0, MAX_TOOLS_PER_TURN);
	return chosen.slice(0, MAX_TOOLS_PER_TURN);
}

export function asksAboutAccess(text: string): boolean {
	return /\b(token|scopes?|permissions?|permiss[õo]es|ferramentas?|functions?|fun[çc][õo]es)\b/i.test(text);
}
