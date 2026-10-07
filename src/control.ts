import { createConnection, createServer, type Server } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const SOCKET_NAME = 'control.sock';
const CONTROL_TIMEOUT_MS = 2000;
const SHUTDOWN_WAIT_MS = 10_000;
const SHUTDOWN_POLL_MS = 100;

const socketPath = (dataDir: string): string => join(dataDir, SOCKET_NAME);

/** A private local control socket lets `stop` reach a foreground or service process. */
export async function startControl(dataDir: string, stop: () => void): Promise<() => Promise<void>> {
	const path = socketPath(dataDir);
	if (existsSync(path)) {
		if (await requestStop(dataDir, 'probe')) throw new Error('ontoplano-chat is already running');
		unlinkSync(path);
	}
	const server = createServer((client) => {
		client.once('data', (data) => {
			if (data.toString().trim() !== 'stop') return client.end('unknown command\n');
			client.end('stopping\n', stop);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(path, resolve);
	});
	return () => closeControl(server, path);
}

async function closeControl(server: Server, path: string): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (existsSync(path)) unlinkSync(path);
}

/** A `probe` never stops anything. A positive stop is acknowledged by the server. */
export function requestStop(dataDir: string, command = 'stop'): Promise<boolean> {
	return new Promise((resolve) => {
		const client = createConnection(socketPath(dataDir));
		let answer = '';
		let done = false;
		const finish = (ok: boolean): void => {
			if (done) return;
			done = true;
			client.destroy();
			resolve(ok);
		};
		client.setTimeout(CONTROL_TIMEOUT_MS, () => finish(false));
		client.on('connect', () => client.write(`${command}\n`));
		client.on('data', (data: Buffer) => (answer += data.toString()));
		client.on('end', () => finish(command === 'probe' ? true : answer.trim() === 'stopping'));
		client.on('error', () => finish(false));
	});
}

export async function waitForControlClose(dataDir: string): Promise<boolean> {
	const until = Date.now() + SHUTDOWN_WAIT_MS;
	while (existsSync(socketPath(dataDir)) && Date.now() < until)
		await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS));
	return !existsSync(socketPath(dataDir));
}
