import type { McpTool } from './mcp.js';

/** Small local models lose track of a 95-tool schema dump. Keep the authorized
 * list intact, but show the model the tools related to this request. */
const MAX_TOOLS_PER_TURN = 28;
const normalize = (text: string): string =>
	text
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();
const TOPICS: { ask: RegExp; tool: RegExp }[] = [
	{
		ask: /\b(notebook|caderno|nota|note|diario|diary|entry|anota|escrev|escrit)/i,
		tool: /notebook|note|entry|diary|idea|search/i
	},
	{
		ask: /\b(task|todo|tarefa|atividade|agenda|calendar|calendario|schedule|marcar)/i,
		tool: /task|today|upcoming|block|search/i
	},
	{ ask: /\b(bill|invoice|payment|conta|fatura|boleto|pagamento)/i, tool: /bill|payment/i },
	{ ask: /\b(goal|meta|progress|progresso)/i, tool: /goal|progress/i },
	{ ask: /\b(workout|treino|exercicio)/i, tool: /workout/i },
	{ ask: /\b(shopping|compras?|mercado|inventory|inventario)/i, tool: /shopping|inventory|bought/i },
	{ ask: /\b(habit|habito)/i, tool: /habit/i },
	{ ask: /\b(today|hoje|amanha|tomorrow|week|semana)/i, tool: /today|upcoming|task|block|repeating/i }
];

export function selectTools(request: string, all: readonly McpTool[]): McpTool[] {
	if (all.length <= MAX_TOOLS_PER_TURN) return [...all];
	const relevant = TOPICS.filter((topic) => topic.ask.test(normalize(request)));
	const chosen = relevant.length
		? all.filter((tool) => relevant.some((topic) => topic.tool.test(tool.name)))
		: all.slice(0, MAX_TOOLS_PER_TURN);
	return chosen.slice(0, MAX_TOOLS_PER_TURN);
}

/** One expanded retry when the person asked for an action but the model used no tool. */
export function requestsAction(request: string): boolean {
	const words = normalize(request);
	const verbs =
		/\b(add|create|write|make|update|change|edit|delete|remove|move|schedule|mark|log|record|set|archive|reopen|cria|crie|criar|adiciona|adicione|escreve|escreva|anota|altera|muda|marca|registra|registre|agenda|apaga|exclui|arquiva|reabre|faca)\b/;
	if (/\b(nao|not|do not|don't)\s+/.test(words.slice(0, 30))) return false;
	return verbs.test(words);
}

export function asksAboutAccess(text: string): boolean {
	return /\b(token|scopes?|permissions?|permissoes|ferramentas?|functions?|funcoes)\b/i.test(normalize(text));
}
