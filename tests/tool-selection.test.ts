import { expect, it } from 'vitest';

import type { McpTool } from '../src/mcp.js';
import { asksAboutAccess, selectTools } from '../src/tool-selection.js';

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
