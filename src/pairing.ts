/*
 * Who may talk to this server: the paired phones.
 *
 * A phone is paired once, with a short code the server prints, and holds a
 * long random token from then on. The server keeps only the token's hash, so
 * `devices.json` being read is not the same as a phone being cloned. Pairing
 * is the one unauthenticated write, and it is small: a code lives ten
 * minutes, burns after five wrong guesses, and is used once.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEVICE_TOKEN_BYTES, PAIRING_CODE_DIGITS, PAIRING_CODE_TTL_MS, PAIRING_MAX_ATTEMPTS } from './constants.js';

export type Device = { name: string; createdAt: string; lastSeenAt: string | null };
type Stored = Device & { hash: string };
type Pairing = { hash: string; expiresAt: number; attempts: number };

export type PairingFailure = 'no-code' | 'expired' | 'wrong' | 'burned' | 'name';
export class PairingError extends Error {
	constructor(public readonly reason: PairingFailure) {
		super(reason);
	}
}

const DEVICES_FILE = 'devices.json';
const PAIRING_FILE = 'pairing.json';
const MAX_NAME = 60;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function writePrivate(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, path);
}

export class Devices {
	private readonly devicesPath: string;
	private readonly pairingPath: string;

	constructor(private readonly dataDir: string) {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		this.devicesPath = join(dataDir, DEVICES_FILE);
		this.pairingPath = join(dataDir, PAIRING_FILE);
	}

	private read(): Stored[] {
		if (!existsSync(this.devicesPath)) return [];
		try {
			const parsed = JSON.parse(readFileSync(this.devicesPath, 'utf8')) as { devices?: Stored[] };
			return Array.isArray(parsed.devices) ? parsed.devices : [];
		} catch {
			return [];
		}
	}

	private write(devices: Stored[]): void {
		writePrivate(this.devicesPath, JSON.stringify({ devices }, null, '\t') + '\n');
	}

	private readPairing(): Pairing | null {
		if (!existsSync(this.pairingPath)) return null;
		try {
			return JSON.parse(readFileSync(this.pairingPath, 'utf8')) as Pairing;
		} catch {
			return null;
		}
	}

	private clearPairing(): void {
		if (existsSync(this.pairingPath)) unlinkSync(this.pairingPath);
	}

	/** A fresh code, replacing any earlier one. Written hashed, like a token: a code on disk is a code. */
	issueCode(now: number = Date.now()): { code: string; expiresAt: number } {
		const code = String(randomInt(0, 10 ** PAIRING_CODE_DIGITS)).padStart(PAIRING_CODE_DIGITS, '0');
		const expiresAt = now + PAIRING_CODE_TTL_MS;
		writePrivate(this.pairingPath, JSON.stringify({ hash: hashToken(code), expiresAt, attempts: 0 }));
		return { code, expiresAt };
	}

	/** Is there a code waiting to be used? For the CLI to say so. */
	pendingCode(now: number = Date.now()): { expiresAt: number } | null {
		const p = this.readPairing();
		return p && p.expiresAt > now && p.attempts < PAIRING_MAX_ATTEMPTS ? { expiresAt: p.expiresAt } : null;
	}

	/** Turn a code into a token, once. */
	redeem(code: string, name: string, now: number = Date.now()): { token: string; device: Device } {
		const cleanName = name.trim().slice(0, MAX_NAME);
		if (!cleanName) throw new PairingError('name');
		const p = this.readPairing();
		if (!p) throw new PairingError('no-code');
		if (p.expiresAt <= now) {
			this.clearPairing();
			throw new PairingError('expired');
		}
		if (p.attempts >= PAIRING_MAX_ATTEMPTS) {
			this.clearPairing();
			throw new PairingError('burned');
		}
		const given = Buffer.from(hashToken(code.replace(/\D/g, '')));
		const want = Buffer.from(p.hash);
		if (given.length !== want.length || !timingSafeEqual(given, want)) {
			p.attempts += 1;
			if (p.attempts >= PAIRING_MAX_ATTEMPTS) {
				this.clearPairing();
				throw new PairingError('burned');
			}
			writePrivate(this.pairingPath, JSON.stringify(p));
			throw new PairingError('wrong');
		}
		this.clearPairing();
		const token = randomBytes(DEVICE_TOKEN_BYTES).toString('base64url');
		const devices = this.read().filter((d) => d.name !== cleanName);
		const device: Stored = {
			name: cleanName,
			hash: hashToken(token),
			createdAt: new Date(now).toISOString(),
			lastSeenAt: null
		};
		devices.push(device);
		this.write(devices);
		return { token, device: publicOf(device) };
	}

	/** The device a bearer token belongs to, or nothing. */
	authenticate(token: string, now: number = Date.now()): Device | null {
		if (!token) return null;
		const given = Buffer.from(hashToken(token));
		const devices = this.read();
		const found = devices.find((d) => {
			const have = Buffer.from(d.hash);
			return have.length === given.length && timingSafeEqual(have, given);
		});
		if (!found) return null;
		// Remembered coarsely — once a minute is plenty for "when was this phone last here".
		const seen = found.lastSeenAt ? Date.parse(found.lastSeenAt) : 0;
		if (now - seen > 60_000) {
			found.lastSeenAt = new Date(now).toISOString();
			this.write(devices);
		}
		return publicOf(found);
	}

	list(): Device[] {
		return this.read().map(publicOf);
	}

	/** Forget a device by name. Answers whether there was one. */
	revoke(name: string): boolean {
		const devices = this.read();
		const kept = devices.filter((d) => d.name !== name);
		if (kept.length === devices.length) return false;
		this.write(kept);
		return true;
	}

	/** Forget the device a token belongs to — the phone's own "forget this device". */
	revokeToken(token: string): boolean {
		const h = hashToken(token);
		const devices = this.read();
		const kept = devices.filter((d) => d.hash !== h);
		if (kept.length === devices.length) return false;
		this.write(kept);
		return true;
	}
}

const publicOf = (d: Stored): Device => ({ name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt });
