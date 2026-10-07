import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV_FILE = join(process.env.HOME ?? '', '.config', 'ontoplano-chat', 'langfuse.env');
const CLOUD_URL = 'https://cloud.langfuse.com';
const TIMEOUT_MS = 10_000;
const KEYS = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'] as const;

/** Read only the service's Langfuse settings; shell environment takes precedence. */
export function langfuseSettings(env: NodeJS.ProcessEnv = process.env, file = ENV_FILE): NodeJS.ProcessEnv {
	const settings: NodeJS.ProcessEnv = {};
	if (existsSync(file)) {
		for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
			const match =
				/^\s*(?:export\s+)?(LANGFUSE_PUBLIC_KEY|LANGFUSE_SECRET_KEY|LANGFUSE_BASE_URL)\s*=\s*(.*?)\s*$/.exec(line);
			if (match) settings[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
		}
	}
	for (const key of KEYS) if (env[key]) settings[key] = env[key];
	return settings;
}

export async function checkLangfuse(
	env: NodeJS.ProcessEnv = process.env,
	fetcher: typeof fetch = fetch,
	file = ENV_FILE
): Promise<number> {
	const settings = langfuseSettings(env, file);
	const publicKey = settings.LANGFUSE_PUBLIC_KEY;
	const secretKey = settings.LANGFUSE_SECRET_KEY;
	const base = settings.LANGFUSE_BASE_URL || CLOUD_URL;
	if (!publicKey || !secretKey) {
		console.error(`Langfuse keys missing: set both in ${file} or this shell`);
		return 1;
	}
	let url: URL;
	try {
		url = new URL('/api/public/projects', base);
	} catch {
		console.error('Invalid LANGFUSE_BASE_URL');
		return 1;
	}
	console.log(`Checking Langfuse at ${url.origin}…`);
	try {
		const response = await fetcher(url, {
			headers: { Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}` },
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!response.ok) {
			console.error(`Langfuse check failed: HTTP ${response.status} ${response.statusText}`);
			return 1;
		}
		console.log('Langfuse reachable; project keys accepted. No trace was sent.');
		return 0;
	} catch (error) {
		console.error(`Langfuse check failed: ${(error as Error).message}`);
		return 1;
	}
}
