/* Pair once per project, the way a person does, and keep the phone's storage for the specs. */
import { expect, test as setup } from '@playwright/test';

import { code, stateFile } from './env.js';

setup('pair', async ({ page }, info) => {
	const project = info.project.name.replace(/^setup-/, '');
	await page.goto('/');
	await page.fill('#pairCode', code());
	await page.fill('#pairName', `e2e ${project}`);
	await page.click('#pairForm button[type=submit]');
	await expect(page.locator('#talk')).toBeVisible();
	await page.context().storageState({ path: stateFile(project) });
});
