import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PAIRING_CODE_TTL_MS, PAIRING_MAX_ATTEMPTS } from '../src/constants.js';
import { Devices, PairingError } from '../src/pairing.js';

let dir: string;
let devices: Devices;
const T0 = 1_700_000_000_000;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'onto-pair-'));
	devices = new Devices(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pairing', () => {
	it('a code becomes a token, once', () => {
		const { code } = devices.issueCode(T0);
		expect(code).toMatch(/^\d{6}$/);
		const { token, device } = devices.redeem(code, 'pixel', T0 + 1000);
		expect(device.name).toBe('pixel');
		expect(devices.authenticate(token, T0 + 2000)?.name).toBe('pixel');
		expect(() => devices.redeem(code, 'again', T0 + 3000)).toThrow(PairingError);
	});

	it('stores the hash, not the token, and nobody else can read the file', () => {
		const { code } = devices.issueCode(T0);
		const { token } = devices.redeem(code, 'pixel', T0);
		const file = readFileSync(join(dir, 'devices.json'), 'utf8');
		expect(file).not.toContain(token);
		expect(statSync(join(dir, 'devices.json')).mode & 0o777).toBe(0o600);
	});

	it('the code on disk is hashed too', () => {
		const { code } = devices.issueCode(T0);
		expect(readFileSync(join(dir, 'pairing.json'), 'utf8')).not.toContain(code);
	});

	it('expires', () => {
		const { code } = devices.issueCode(T0);
		expect(() => devices.redeem(code, 'late', T0 + PAIRING_CODE_TTL_MS + 1)).toThrow(/expired/);
		expect(() => devices.redeem(code, 'late', T0)).toThrow(/no-code/);
	});

	it('burns after too many wrong guesses', () => {
		const { code } = devices.issueCode(T0);
		for (let i = 0; i < PAIRING_MAX_ATTEMPTS - 1; i++) expect(() => devices.redeem('000000', 'x', T0)).toThrow(/wrong/);
		expect(() => devices.redeem('000000', 'x', T0)).toThrow(/burned/);
		expect(() => devices.redeem(code, 'x', T0)).toThrow(/no-code/);
	});

	it('wants a name', () => {
		devices.issueCode(T0);
		expect(() => devices.redeem('123456', '   ', T0)).toThrow(/name/);
	});

	it('a wrong token is nobody', () => {
		expect(devices.authenticate('nope', T0)).toBeNull();
		expect(devices.authenticate('', T0)).toBeNull();
	});

	it('revokes by name and by token', () => {
		const a = devices.redeem(devices.issueCode(T0).code, 'a', T0);
		const b = devices.redeem(devices.issueCode(T0).code, 'b', T0);
		expect(devices.list().map((d) => d.name)).toEqual(['a', 'b']);
		expect(devices.revoke('a')).toBe(true);
		expect(devices.revoke('a')).toBe(false);
		expect(devices.authenticate(a.token, T0)).toBeNull();
		expect(devices.revokeToken(b.token)).toBe(true);
		expect(devices.list()).toEqual([]);
	});

	it('pairing again under the same name replaces the old token', () => {
		const first = devices.redeem(devices.issueCode(T0).code, 'phone', T0);
		const second = devices.redeem(devices.issueCode(T0).code, 'phone', T0);
		expect(devices.authenticate(first.token, T0)).toBeNull();
		expect(devices.authenticate(second.token, T0)?.name).toBe('phone');
		expect(devices.list()).toHaveLength(1);
	});
});
