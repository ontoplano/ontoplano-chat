import { randomUUID } from 'node:crypto';
import { getActiveTraceId } from '@langfuse/tracing';

import { checkLangfuse } from './langfuse-check.js';
import { langfuseTelemetry } from './observability.js';

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1000;

export async function traceTest(settings: { publicKey: string; secretKey: string; baseUrl: string }): Promise<number> {
	const env = {
		LANGFUSE_PUBLIC_KEY: settings.publicKey,
		LANGFUSE_SECRET_KEY: settings.secretKey,
		LANGFUSE_BASE_URL: settings.baseUrl
	};
	if (await checkLangfuse(env)) return 1;
	const marker = `ontoplano-chat-smoke-${randomUUID()}`;
	const telemetry = langfuseTelemetry(env);
	let traceId: string | undefined;
	try {
		traceId = await telemetry.run('ontoplano-chat-smoke-test', 'agent', { input: marker }, async (span) => {
			span.update({ output: 'synthetic trace; no Ontoplano data' });
			return getActiveTraceId();
		});
	} finally {
		await telemetry.shutdown();
	}
	if (!traceId) {
		console.error('Langfuse did not create a local trace ID');
		return 1;
	}
	console.log(`Sent synthetic trace ${traceId}; waiting for ingestion…`);
	const found = await waitForTrace(settings, traceId);
	if (found) {
		console.log(`Trace visible in Langfuse: ${traceId}`);
		return 0;
	}
	console.error(
		`Trace ${traceId} was not visible after ${POLL_ATTEMPTS} checks. Inspect Langfuse ingestion logs and base URL.`
	);
	return 1;
}

export async function waitForTrace(
	settings: { publicKey: string; secretKey: string; baseUrl: string },
	traceId: string,
	fetcher: typeof fetch = fetch,
	attempts = POLL_ATTEMPTS,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<boolean> {
	const url = new URL('/api/public/v2/observations', settings.baseUrl);
	url.searchParams.set('traceId', traceId);
	url.searchParams.set('fields', 'core');
	url.searchParams.set('limit', '1');
	const authorization = `Basic ${Buffer.from(`${settings.publicKey}:${settings.secretKey}`).toString('base64')}`;
	for (let i = 0; i < attempts; i++) {
		try {
			const response = await fetcher(url, {
				headers: { Authorization: authorization },
				signal: AbortSignal.timeout(5000)
			});
			if (response.ok) {
				const body = (await response.json()) as { data?: unknown[] };
				if (body.data?.length) return true;
			} else if (response.status !== 404 && response.status !== 429 && response.status < 500) {
				console.error(`Langfuse observation lookup failed: HTTP ${response.status}`);
				return false;
			}
		} catch {
			// The collector and query API can become ready at different times.
		}
		if (i + 1 < attempts) await sleep(POLL_INTERVAL_MS);
	}
	return false;
}
