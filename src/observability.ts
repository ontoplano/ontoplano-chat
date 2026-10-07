import { LangfuseSpanProcessor } from '@langfuse/otel';
import { propagateAttributes, startActiveObservation, type LangfuseObservationAttributes } from '@langfuse/tracing';
import { NodeSDK } from '@opentelemetry/sdk-node';

export type Observation = { update(data: LangfuseObservationAttributes): void };
export type Telemetry = {
	run<T>(
		name: string,
		kind: 'agent' | 'generation' | 'tool',
		input: unknown,
		work: (span: Observation) => Promise<T>
	): Promise<T>;
	shutdown(): Promise<void>;
};

const SECRET_FIELD = /(?:authorization|credential|secret|password|token|api[_-]?key|cookie)/i;
const BEARER = /Bearer\s+[^\s"']+/gi;
const KEY = /\b(?:sk|pk|lf|ghp|glpat)[_-][A-Za-z0-9_-]{12,}\b/g;
const QUERY_SECRET = /\b(token|api[_-]?key|secret|password)=([^\s&"']+)/gi;

/** Single policy for every trace payload. Add application-specific secret patterns here. */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
	if (typeof value === 'string') {
		let clean = value
			.replace(BEARER, 'Bearer [REDACTED]')
			.replace(KEY, '[REDACTED]')
			.replace(QUERY_SECRET, '$1=[REDACTED]');
		for (const secret of secrets.filter((s) => s.length >= 4)) clean = clean.replaceAll(secret, '[REDACTED]');
		return clean;
	}
	if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, SECRET_FIELD.test(key) ? '[REDACTED]' : redact(item, secrets)])
		);
	return value;
}

export function disabledTelemetry(): Telemetry {
	return { run: async (_name, _kind, _input, work) => work({ update: () => {} }), shutdown: async () => {} };
}

export function langfuseTelemetry(env: NodeJS.ProcessEnv = process.env, secrets: readonly string[] = []): Telemetry {
	if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return disabledTelemetry();
	const clean = (data: unknown): unknown =>
		redact(data, [...secrets, env.LANGFUSE_PUBLIC_KEY!, env.LANGFUSE_SECRET_KEY!]);
	const sdk = new NodeSDK({
		spanProcessors: [
			new LangfuseSpanProcessor({
				publicKey: env.LANGFUSE_PUBLIC_KEY,
				secretKey: env.LANGFUSE_SECRET_KEY,
				baseUrl: env.LANGFUSE_BASE_URL,
				mask: ({ data }) => {
					try {
						return JSON.stringify(clean(JSON.parse(data)));
					} catch {
						return String(clean(data));
					}
				}
			})
		]
	});
	sdk.start();
	return {
		async run<T>(
			name: string,
			kind: 'agent' | 'generation' | 'tool',
			input: unknown,
			work: (span: Observation) => Promise<T>
		): Promise<T> {
			const execute = async (span: Observation): Promise<T> => {
				span.update({ input: clean(input) });
				try {
					return await work({ update: (data) => span.update(clean(data) as LangfuseObservationAttributes) });
				} catch (error) {
					span.update({ level: 'ERROR', statusMessage: String(clean((error as Error).message)) });
					throw error;
				}
			};
			const observe = (): Promise<T> => {
				if (kind === 'generation') return startActiveObservation(name, execute, { asType: 'generation' });
				if (kind === 'tool') return startActiveObservation(name, execute, { asType: 'tool' });
				return startActiveObservation(name, execute, { asType: 'agent' });
			};
			const sessionId =
				kind === 'agent' && input && typeof input === 'object' && 'sessionId' in input ? input.sessionId : null;
			return typeof sessionId === 'string' ? propagateAttributes({ sessionId }, observe) : observe();
		},
		async shutdown() {
			try {
				await sdk.shutdown();
			} catch {
				/* An unavailable collector cannot fail the assistant. */
			}
		}
	};
}
