/*
 * The HTTP side: the phone's page, and the few calls it makes.
 *
 *   GET  /                 the page (and its files)
 *   GET  /api/health       is it up — public, says nothing else
 *   POST /api/pair         a code for a token — the one unauthenticated write
 *   GET  /api/me           who am I, what can this assistant do
 *   GET  /api/status       the engines, for the settings sheet
 *   POST /api/turn         say something: text, or audio — answered as a stream of events
 *   POST /api/confirm      yes or no to a pending question — the same stream
 *   GET  /api/history      what was said and done
 *   POST /api/forget       this phone's token, revoked
 *
 * Everything under /api but health and pair carries `Authorization: Bearer`.
 * No cookies, so no CSRF; a strict CSP, so no script but ours; body ceilings
 * on everything that reads one.
 */
import { createServer as httpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Config } from './config.js';
import {
	MAX_AUDIO_BYTES,
	MAX_JSON_BYTES,
	PAIRING_RATE_LIMIT,
	PAIRING_RATE_WINDOW_MS,
	TURN_RATE_LIMIT,
	TURN_RATE_WINDOW_MS
} from './constants.js';
import type { Engines } from './engines.js';
import type { History } from './history.js';
import { PairingError, type Device, type Devices } from './pairing.js';
import type { Assistant, TurnEvent } from './turn.js';

export type ServerDeps = {
	config: Config;
	devices: Devices;
	assistant: Assistant;
	history: History;
	engines: Engines;
	version: string;
	log?: (line: string) => void;
	now?: () => number;
};

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.webmanifest': 'application/manifest+json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon'
};

/** Named explicitly, once, at start: nothing outside this list is ever read for a request. */
function staticFiles(dir: string): Map<string, { path: string; type: string }> {
	const files = new Map<string, { path: string; type: string }>();
	const walk = (sub: string): void => {
		for (const entry of readdirSync(join(dir, sub))) {
			const rel = sub ? `${sub}/${entry}` : entry;
			const full = join(dir, rel);
			if (statSync(full).isDirectory()) walk(rel);
			else {
				const type = TYPES[extname(entry)];
				if (type) files.set(`/${rel}`, { path: full, type });
			}
		}
	};
	if (existsSync(dir)) walk('');
	return files;
}

/** So many in a window, per key, and then no. */
export class RateLimit {
	private readonly hits = new Map<string, number[]>();
	constructor(
		private readonly limit: number,
		private readonly windowMs: number
	) {}
	allow(key: string, now: number): boolean {
		const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
		if (list.length >= this.limit) {
			this.hits.set(key, list);
			return false;
		}
		list.push(now);
		this.hits.set(key, list);
		return true;
	}
}

class HttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message?: string
	) {
		super(message ?? code);
	}
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (c: Buffer) => {
			size += c.length;
			if (size > max) {
				reject(new HttpError(413, 'too-large', `the body is over ${max} bytes`));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const raw = await readBody(req, MAX_JSON_BYTES);
	try {
		const parsed = JSON.parse(raw.toString('utf8') || '{}') as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
		return parsed as Record<string, unknown>;
	} catch {
		throw new HttpError(400, 'bad-json');
	}
}

export function createApp(deps: ServerDeps): (req: IncomingMessage, res: ServerResponse) => void {
	const { config, devices, assistant, history, engines } = deps;
	const log = deps.log ?? (() => {});
	const now = deps.now ?? (() => Date.now());
	const files = staticFiles(WEB_DIR);
	const pairLimit = new RateLimit(PAIRING_RATE_LIMIT, PAIRING_RATE_WINDOW_MS);
	const turnLimit = new RateLimit(TURN_RATE_LIMIT, TURN_RATE_WINDOW_MS);
	const tls = Boolean(config.server.tls.cert && config.server.tls.key);

	const headers = (res: ServerResponse): void => {
		res.setHeader(
			'Content-Security-Policy',
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
		);
		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.setHeader('Referrer-Policy', 'no-referrer');
		res.setHeader('X-Frame-Options', 'DENY');
		res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
		res.setHeader('Cache-Control', 'no-store');
		if (tls) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
	};

	const json = (res: ServerResponse, status: number, body: unknown): void => {
		res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(body));
	};

	const authenticate = (req: IncomingMessage): { device: Device; token: string } => {
		const header = req.headers.authorization ?? '';
		if (!header.toLowerCase().startsWith('bearer ')) throw new HttpError(401, 'unauthorized');
		const token = header.slice(7).trim();
		const device = devices.authenticate(token, now());
		if (!device) throw new HttpError(401, 'unauthorized');
		return { device, token };
	};

	const stream = (res: ServerResponse, req: IncomingMessage): ((e: TurnEvent) => void) => {
		res.writeHead(200, {
			'Content-Type': 'application/x-ndjson; charset=utf-8',
			'X-Accel-Buffering': 'no'
		});
		let open = true;
		req.on('close', () => (open = false));
		return (e) => {
			if (open) res.write(JSON.stringify(e) + '\n');
		};
	};

	const serveStatic = (path: string, res: ServerResponse): boolean => {
		const file = files.get(path === '/' ? '/index.html' : path);
		if (!file) return false;
		let body: Buffer | string = readFileSync(file.path);
		if (path === '/sw.js') body = body.toString('utf8').replaceAll('__VERSION__', deps.version);
		res.writeHead(200, {
			'Content-Type': file.type,
			'Cache-Control': file.type.startsWith('image/') ? 'public, max-age=86400' : 'no-cache'
		});
		res.end(body);
		return true;
	};

	return (req, res) => {
		void (async () => {
			headers(res);
			const url = new URL(req.url ?? '/', 'http://local');
			const path = url.pathname;
			const ip = req.socket.remoteAddress ?? 'unknown';
			try {
				if (!path.startsWith('/api/')) {
					if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method');
					if (!serveStatic(path, res)) throw new HttpError(404, 'not-found');
					return;
				}
				if (path === '/api/health' && req.method === 'GET')
					return json(res, 200, { ok: true, name: 'ontoplano-chat', version: deps.version });
				if (path === '/api/pair' && req.method === 'POST') {
					if (!pairLimit.allow(ip, now())) throw new HttpError(429, 'slow-down');
					const body = await readJson(req);
					try {
						const { token, device } = devices.redeem(String(body.code ?? ''), String(body.name ?? ''), now());
						log(`paired: ${device.name}`);
						return json(res, 200, { token, device });
					} catch (e) {
						if (e instanceof PairingError) throw new HttpError(e.reason === 'name' ? 400 : 403, `pair-${e.reason}`);
						throw e;
					}
				}
				const { device, token } = authenticate(req);
				if (path === '/api/me' && req.method === 'GET')
					return json(res, 200, {
						device,
						assistant: { name: config.assistant.name, language: config.assistant.language },
						stt: engines.stt.kind,
						tts: engines.tts.kind,
						app: config.ontoplano.url,
						version: deps.version,
						pending: assistant.pending(device.name)
					});
				if (path === '/api/status' && req.method === 'GET') {
					const [llm, stt, tts] = await Promise.all([engines.llm.check(), engines.stt.check(), engines.tts.check()]);
					return json(res, 200, {
						llm: { model: engines.llm.model, problem: llm },
						stt: { kind: engines.stt.kind, about: engines.stt.about, problem: stt },
						tts: { kind: engines.tts.kind, about: engines.tts.about, problem: tts },
						tools: {
							offered: engines.tools.current().length,
							granted: engines.tools.granted().length,
							problem: engines.tools.lastError,
							names: engines.tools.current().map((t) => t.name)
						},
						fake: engines.fake
					});
				}
				if (path === '/api/history' && req.method === 'GET')
					return json(res, 200, { turns: history.recent(device.name) });
				if (path === '/api/forget' && req.method === 'POST') {
					devices.revokeToken(token);
					assistant.forget(device.name);
					log(`forgot: ${device.name}`);
					return json(res, 200, { ok: true });
				}
				if (path === '/api/turn' && req.method === 'POST') {
					if (!turnLimit.allow(device.name, now())) throw new HttpError(429, 'slow-down');
					const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
					if (type.startsWith('audio/')) {
						const bytes = await readBody(req, MAX_AUDIO_BYTES);
						const emit = stream(res, req);
						await assistant.turn(device.name, { audio: { bytes: new Uint8Array(bytes), mime: type } }, emit);
						return res.end();
					}
					const body = await readJson(req);
					const emit = stream(res, req);
					await assistant.turn(device.name, { text: String(body.text ?? '') }, emit);
					return res.end();
				}
				if (path === '/api/confirm' && req.method === 'POST') {
					const body = await readJson(req);
					const emit = stream(res, req);
					await assistant.resume(device.name, String(body.id ?? ''), body.yes === true, emit);
					return res.end();
				}
				throw new HttpError(404, 'not-found');
			} catch (e) {
				if (res.headersSent) {
					res.end();
					return;
				}
				if (e instanceof HttpError) return json(res, e.status, { error: e.code, message: e.message });
				log(`error: ${(e as Error).stack ?? (e as Error).message}`);
				return json(res, 500, { error: 'server', message: 'something went wrong on the server' });
			}
		})();
	};
}

export function createHttpServer(deps: ServerDeps): Server {
	const handler = createApp(deps);
	const { cert, key } = deps.config.server.tls;
	if (cert && key) return httpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, handler);
	return httpServer(handler);
}
