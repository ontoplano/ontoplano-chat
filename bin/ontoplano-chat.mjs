#!/usr/bin/env node
// The command. Built first: `make build` (or `yarn build`) writes dist/.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const built = new URL('../dist/cli.js', import.meta.url);
if (!existsSync(fileURLToPath(built))) {
	console.error('ontoplano-chat is not built yet: run `make build` (or `yarn build`) first.');
	process.exit(1);
}
const { main } = await import(built.href);
process.exitCode = await main(process.argv.slice(2));
