import { readFileSync, writeFileSync } from 'node:fs';
import prettier from 'prettier';

const source = new URL('../../ontoplano/src/lib/server/mcp/manifest.json', import.meta.url);
const target = new URL('../eval/tools.json', import.meta.url);
const manifest = JSON.parse(readFileSync(source, 'utf8'));
const tools = JSON.parse(readFileSync(target, 'utf8'));

for (const tool of tools) {
	const definition = manifest[tool.name];
	if (!definition) throw new Error(`Ontoplano no longer exposes ${tool.name}`);
	const properties = {};
	const required = [];
	for (const [key, param] of Object.entries(definition.params ?? {})) {
		if (param.deprecated) continue;
		const { required: isRequired, ...schema } = param;
		properties[key] = schema;
		if (isRequired) required.push(key);
	}
	tool.writes = definition.writes;
	tool.destroys = definition.destroys;
	tool.inputSchema = { type: 'object', properties, ...(required.length ? { required } : {}) };
}

const options = await prettier.resolveConfig(target.pathname);
writeFileSync(target, await prettier.format(JSON.stringify(tools), { ...options, filepath: target.pathname }));
console.log(`Updated ${tools.length} eval tool definitions from Ontoplano MCP manifest.`);
