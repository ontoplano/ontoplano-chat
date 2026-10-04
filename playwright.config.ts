/*
 * The phone's page, driven: against a server with fake engines, a throwaway
 * data directory, and a pairing code the global setup printed. Chromium gets
 * a fake microphone so the hold-to-talk path runs end to end.
 */
import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { E2E_CONFIG, E2E_DIR, E2E_PORT, e2eEnv, stateFile } from './e2e/env.js';

// A clean data directory per run — in the main process only; the workers load this file too.
if (!process.env.TEST_WORKER_INDEX) {
	rmSync(E2E_DIR, { recursive: true, force: true });
	mkdirSync(E2E_DIR, { recursive: true });
	writeFileSync(
		E2E_CONFIG,
		`[server]\nport = ${E2E_PORT}\n[assistant]\nlanguage = "en"\n[ontoplano]\nurl = "https://app.example"\n`
	);
}

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.ts',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	outputDir: 'test-results/playwright',
	use: {
		baseURL: `http://127.0.0.1:${E2E_PORT}`,
		trace: 'retain-on-failure',
		launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }
	},
	projects: [
		{ name: 'setup-phone', testMatch: /pair\.setup\.ts/, use: { ...devices['Pixel 7'], hasTouch: false } },
		{
			name: 'phone',
			dependencies: ['setup-phone'],
			use: { ...devices['Pixel 7'], hasTouch: false, storageState: stateFile('phone') }
		},
		{
			name: 'setup-desktop',
			testMatch: /pair\.setup\.ts/,
			use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } }
		},
		{
			name: 'desktop',
			dependencies: ['setup-desktop'],
			use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 }, storageState: stateFile('desktop') }
		}
	],
	webServer: {
		command: 'npx tsx src/cli.ts serve',
		url: `http://127.0.0.1:${E2E_PORT}/api/health`,
		reuseExistingServer: false,
		env: e2eEnv,
		timeout: 30_000
	}
});
