/* Where the e2e server lives and keeps its throwaway state; shared by the config and the specs. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const E2E_PORT = 14970;
export const E2E_DIR = join(import.meta.dirname, '..', 'test-results', 'e2e-data');
export const E2E_CONFIG = join(E2E_DIR, 'config.toml');

export const e2eEnv = {
	...process.env,
	ONTOPLANO_CHAT_ENGINES: 'fake',
	ONTOPLANO_CHAT_DATA: E2E_DIR,
	ONTOPLANO_CHAT_CONFIG: E2E_CONFIG
};

/** Where a project's paired storage lands, for its specs to start from. */
export const stateFile = (project: string): string => join(E2E_DIR, `state-${project}.json`);

/** A pairing code the way a person gets one: from the command. One per pairing, since a code is used once. */
export function code(): string {
	const out = execFileSync('npx', ['tsx', 'src/cli.ts', 'pair'], { env: e2eEnv, encoding: 'utf8' });
	const found = out.match(/\b(\d{6})\b/)?.[1];
	if (!found) throw new Error(`no pairing code in:\n${out}`);
	return found;
}
