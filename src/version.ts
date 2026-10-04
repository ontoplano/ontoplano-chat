import { readFileSync } from 'node:fs';

/** The version in package.json — the one number that says which build this is. */
export const VERSION: string = (() => {
	try {
		return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
			.version;
	} catch {
		return '0.0.0';
	}
})();
