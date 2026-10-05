/*
 * Ears and voice: speech to text, text to speech.
 *
 * Both are HTTP calls to something on this machine — Speaches, whisper.cpp's
 * server, LocalAI — or, for the voice, the piper binary. "browser" means the
 * phone does that half itself; the server then has nothing to do here.
 */
import { spawn } from 'node:child_process';

import { SPEECH_TIMEOUT_MS } from './constants.js';

export type Stt = {
	kind: 'openai' | 'whispercpp' | 'browser';
	transcribe(audio: Uint8Array, mime: string, language?: string): Promise<string>;
	check(): Promise<string | null>;
};

export type Spoken = { mime: string; bytes: Uint8Array };

export type Tts = {
	kind: 'openai' | 'piper' | 'browser';
	/** `null` when the phone speaks for itself. */
	speak(text: string): Promise<Spoken | null>;
	check(): Promise<string | null>;
};

export class SpeechError extends Error {}

type SttOptions = {
	kind: 'openai' | 'whispercpp';
	url: string;
	path: string;
	model: string;
	language: string;
	apiKey?: string;
	fetchImpl?: typeof fetch;
};

const extensionOf = (mime: string): string => {
	if (mime.includes('webm')) return 'webm';
	if (mime.includes('ogg')) return 'ogg';
	if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
	if (mime.includes('wav')) return 'wav';
	if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
	return 'bin';
};

export function httpStt(o: SttOptions): Stt {
	const fetchImpl = o.fetchImpl ?? fetch;
	const headers: Record<string, string> = o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {};
	return {
		kind: o.kind,
		async transcribe(audio, mime, language = o.language) {
			const form = new FormData();
			form.append('file', new Blob([audio], { type: mime }), `turn.${extensionOf(mime)}`);
			form.append('response_format', 'json');
			if (language) form.append('language', language);
			if (o.kind === 'openai') form.append('model', o.model);
			let res: Response;
			try {
				res = await fetchImpl(`${o.url}${o.path}`, {
					method: 'POST',
					headers,
					body: form,
					signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS)
				});
			} catch (e) {
				throw new SpeechError(`no transcriber at ${o.url}: ${(e as Error).message}`);
			}
			if (!res.ok) throw new SpeechError(`the transcriber answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
			const body = (await res.json()) as { text?: string };
			return (body.text ?? '').trim();
		},
		async check() {
			try {
				const res = await fetchImpl(o.url, { method: 'GET', headers, signal: AbortSignal.timeout(5000) });
				return res.status >= 500 ? `${o.url} answered ${res.status}` : null;
			} catch (e) {
				return `no transcriber at ${o.url}: ${(e as Error).message}`;
			}
		}
	};
}

export const browserStt: Stt = {
	kind: 'browser',
	transcribe: async () => {
		throw new SpeechError('speech is recognised on the phone (stt.kind = "browser"); send text');
	},
	check: async () => null
};

export const browserTts: Tts = {
	kind: 'browser',
	speak: async () => null,
	check: async () => null
};

type OpenAiTtsOptions = { url: string; model: string; voice: string; apiKey?: string; fetchImpl?: typeof fetch };

export function openAiTts(o: OpenAiTtsOptions): Tts {
	const fetchImpl = o.fetchImpl ?? fetch;
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;
	return {
		kind: 'openai',
		async speak(text) {
			let res: Response;
			try {
				res = await fetchImpl(`${o.url}/v1/audio/speech`, {
					method: 'POST',
					headers,
					signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
					body: JSON.stringify({ model: o.model, voice: o.voice, input: text, response_format: 'mp3' })
				});
			} catch (e) {
				throw new SpeechError(`no voice at ${o.url}: ${(e as Error).message}`);
			}
			if (!res.ok) throw new SpeechError(`the voice answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
			const mime = res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg';
			return { mime, bytes: new Uint8Array(await res.arrayBuffer()) };
		},
		async check() {
			try {
				const res = await fetchImpl(o.url, { method: 'GET', signal: AbortSignal.timeout(5000) });
				return res.status >= 500 ? `${o.url} answered ${res.status}` : null;
			} catch (e) {
				return `no voice at ${o.url}: ${(e as Error).message}`;
			}
		}
	};
}

type PiperOptions = { command: string; model: string };

export function piperTts(o: PiperOptions): Tts {
	return {
		kind: 'piper',
		speak(text) {
			return new Promise<Spoken>((resolve, reject) => {
				const child = spawn(o.command, ['--model', o.model, '--output_file', '-'], {
					stdio: ['pipe', 'pipe', 'pipe']
				});
				const chunks: Buffer[] = [];
				let err = '';
				const timer = setTimeout(() => {
					child.kill();
					reject(new SpeechError(`piper took longer than ${SPEECH_TIMEOUT_MS / 1000}s`));
				}, SPEECH_TIMEOUT_MS);
				child.stdout.on('data', (c: Buffer) => chunks.push(c));
				child.stderr.on('data', (c: Buffer) => (err += c.toString()));
				child.on('error', (e) => {
					clearTimeout(timer);
					reject(new SpeechError(`cannot run ${o.command}: ${e.message}`));
				});
				child.on('close', (code) => {
					clearTimeout(timer);
					if (code !== 0) return reject(new SpeechError(`piper exited ${code}: ${err.slice(0, 200)}`));
					resolve({ mime: 'audio/wav', bytes: new Uint8Array(Buffer.concat(chunks)) });
				});
				child.stdin.end(text);
			});
		},
		check() {
			return new Promise((resolve) => {
				const child = spawn(o.command, ['--help'], { stdio: 'ignore' });
				child.on('error', (e) => resolve(`cannot run ${o.command}: ${e.message}`));
				child.on('close', () => resolve(null));
			});
		}
	};
}
