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

/** A narrow retry is warranted only when the person plainly asked to create something. */
export function creationTool(request: string, all: readonly McpTool[]): McpTool | undefined {
	const words = normalize(request);
	if (/\b(?:nao|not|do not|don't)\s+(?:crie|cria|criar|escreva|escreve|create|write|add)\b/.test(words)) return;
	const create = /\b(cria|crie|criar|adiciona|adicione|adicionar|create|add|make|faz|faca)\b/.test(words);
	const write = /\b(escreve|escreva|escrever|anota|anote|write)\b/.test(words);
	if (create && /\b(task|tarefa|todo)\b/.test(words)) return all.find((tool) => tool.name === 'add_task');
	if ((create || write) && /\b(nota|note|entry|caderno|notebook)\b/.test(words))
		return all.find((tool) => tool.name === 'write_entry');
	if (write && /\b(qualquer coisa|anything)\b/.test(words)) return all.find((tool) => tool.name === 'write_entry');
	return;
}

/** Explicit task fields are safe to carry through even if a model drops them. */
export function taskFields(request: string): {
	tags?: string;
	ratings: Partial<Record<'urgency' | 'ease' | 'interest', number>>;
} {
	const normalized = normalize(request);
	const ratings: Partial<Record<'urgency' | 'ease' | 'interest', number>> = {};
	for (const [field, names] of [
		['urgency', 'urgencia|urgency'],
		['ease', 'facilidade|ease'],
		['interest', 'interesse|interest']
	] as const) {
		const match = new RegExp(`\\b(?:${names})\\s*[:=]?\\s*([0-5])\\b`).exec(normalized);
		if (match) ratings[field] = Number(match[1]);
	}
	const tag = /\btag(?:s)?\s*[:=]?\s*([\p{L}\p{N}_-]+)/iu.exec(request);
	return { ...(tag ? { tags: tag[1] } : {}), ratings };
}

export function asksAboutAccess(text: string): boolean {
	return /\b(token|scopes?|permissions?|permissoes|ferramentas?|functions?|funcoes)\b/i.test(normalize(text));
}
