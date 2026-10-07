import { expect, it } from 'vitest';

import type { McpTool } from '../src/mcp.js';
import { asksAboutAccess, creationTool, selectTools, taskFields } from '../src/tool-selection.js';

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
	expect(creationTool('escreve qualquer coisa em qualquer caderno', all)?.name).toBe('write_entry');
	expect(creationTool('sim, escreve qualquer coisa lá', all)?.name).toBe('write_entry');
	expect(creationTool('cria uma task: organizar arquivos', all)?.name).toBe('add_task');
	expect(creationTool('não crie uma task', all)).toBeUndefined();
	expect(taskFields('tag: teste. Urgência 4, facilidade 5, interesse 1')).toEqual({
		tags: 'teste',
		ratings: { urgency: 4, ease: 5, interest: 1 }
	});
});
