import { expect, it } from 'vitest';

import type { McpTool } from '../src/mcp.js';
import { asksAboutAccess, requestsAction, selectTools } from '../src/tool-selection.js';

const tool = (name: string): McpTool => ({ name, description: '', inputSchema: { type: 'object' } });

it('selects notebook tools even when a large grant ends with bill tools', () => {
	const all = [
		tool('notebooks'),
		tool('notebook_notes'),
		tool('write_entry'),
		...Array.from({ length: 92 }, (_, i) => tool(`bill_${i}`))
	];
	expect(selectTools('cria uma nota no caderno', all).map((item) => item.name)).toEqual([
		'notebooks',
		'notebook_notes',
		'write_entry'
	]);
	expect(selectTools('name of the notebook I can access', all).map((item) => item.name)).toContain('notebooks');
});

it('recognizes a question about capabilities rather than guessing token scope', () => {
	expect(asksAboutAccess('quais ferramentas meu token permite?')).toBe(true);
	expect(asksAboutAccess('can you access my notebook?')).toBe(false);
});

it('selects Portuguese writing and task creation even with a large tool list', () => {
	const all = [
		...Array.from({ length: 92 }, (_, i) => tool(`bill_${i}`)),
		tool('notebooks'),
		tool('write_entry'),
		tool('add_task')
	];
	expect(selectTools('ESCREVE qualquer coisa em qualquer caderno', all).map((item) => item.name)).toContain(
		'write_entry'
	);
	expect(selectTools('cria uma tarefa: organizar arquivos', all).map((item) => item.name)).toContain('add_task');
	expect(requestsAction('sim, escreve qualquer coisa lá')).toBe(true);
	expect(requestsAction('cria uma task: organizar arquivos')).toBe(true);
	expect(requestsAction('registre uma medição')).toBe(true);
	expect(requestsAction('não crie uma task')).toBe(false);
});
