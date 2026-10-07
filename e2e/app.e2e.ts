import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

import { code } from './env.js';

const SHOTS = join(import.meta.dirname, '..', 'test-results', 'shots');

test.describe.configure({ mode: 'serial' });

/** The project's setup paired this phone already; its storage holds the token. */
async function paired(page: Page): Promise<void> {
	await page.goto('/');
	await expect(page.locator('#talk')).toBeVisible();
}

test('a wrong code says so, in its reserved line, and the right one pairs', async ({ page }, info) => {
	await page.context().clearCookies();
	await page.goto('/');
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.locator('#pairForm')).toBeVisible();
	await expect(page.locator('#pairCode')).toBeFocused();
	const button = page.locator('#pairForm button[type=submit]');
	const before = await button.boundingBox();
	const right = code();
	await page.fill('#pairCode', '000000');
	await page.fill('#pairName', `e2e ${info.project.name} fresh`);
	await button.click();
	await expect(page.locator('#pairError')).toHaveText('That is not the code.');
	expect((await button.boundingBox())?.y).toBe(before?.y);
	await page.screenshot({ path: join(SHOTS, `${info.project.name}-pair.png`) });
	await page.fill('#pairCode', right);
	await button.click();
	await expect(page.locator('#screenChat')).toBeVisible();
	await expect(page.locator('#talk')).toHaveText(/Hold to talk/);
	// the token survives a reload
	await page.reload();
	await expect(page.locator('#talk')).toBeVisible();
});

test('a typed turn draws the reply and a receipt that opens the app', async ({ page }) => {
	await paired(page);
	await page.fill('#text', 'add a task: buy bread');
	await page.press('#text', 'Enter');
	await expect(page.locator('.turn.me .bubble').last()).toHaveText('add a task: buy bread');
	await expect(page.locator('.turn.bot .bubble').last()).toHaveText(/Added #\d+, buy bread\./);
	const chip = page.locator('.turn.bot').last().locator('a.chip.done');
	await expect(chip).toHaveText(/add task · #\d+ buy bread/);
	await expect(chip).toHaveAttribute('href', /https:\/\/app\.example\/tasks\/todo\?edit=\d+/);
	await expect(page.locator('#text')).toBeEnabled();
});

test('speaker button switches spoken replies off and keeps the setting', async ({ page }) => {
	await paired(page);
	const button = page.locator('#toggleVoice');
	await expect(button).toHaveAttribute('aria-pressed', 'true');
	await button.click();
	await expect(button).toHaveAttribute('aria-pressed', 'false');
	await page.reload();
	await expect(button).toHaveAttribute('aria-pressed', 'false');
	await page.locator('#openSettings').click();
	await expect(page.locator('#speakReplies')).not.toBeChecked();
});

test('a destructive action asks, and the yes keeps its place', async ({ page }, info) => {
	await paired(page);
	// The fake app has two notebooks, and each project removes its own: the state is one server's.
	const notebook = info.project.name === 'phone' ? 7 : 8;
	await page.fill('#text', `remove notebook ${notebook}`);
	await page.press('#text', 'Enter');
	const ask = page.locator('.ask').last();
	await expect(ask).toContainText(`remove notebook (id ${notebook})?`);
	const yes = ask.locator('button', { hasText: 'Yes' });
	const no = ask.locator('button', { hasText: 'No' });
	await expect(no).toBeVisible();
	await page.screenshot({ path: join(SHOTS, `${info.project.name}-ask.png`) });
	const askBox = await ask.boundingBox();
	await yes.click();
	await expect(ask).toHaveClass(/answered/);
	await expect(ask).toContainText('— Yes');
	expect((await ask.boundingBox())?.height).toBe(askBox?.height);
	await expect(page.locator('.turn.bot .bubble').last()).toHaveText('The notebook is gone.');
	await page.screenshot({ path: join(SHOTS, `${info.project.name}-chat.png`), fullPage: true });
});

test('holding the bar records and sends; the transcript lands in the bubble', async ({ page, browserName }) => {
	test.skip(browserName !== 'chromium', 'the fake microphone is a Chromium flag');
	await paired(page);
	const talk = page.locator('#talk');
	const box = (await talk.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await expect(talk).toHaveAttribute('aria-pressed', 'true');
	await expect(talk).toHaveText(/Listening/);
	await page.waitForTimeout(900);
	await page.mouse.up();
	await expect(talk).toHaveAttribute('aria-pressed', 'false');
	// the fake ears spell the bytes out, so the transcript is noise — but it is a transcript, drawn in the heard bubble
	const heard = page.locator('.turn.me .bubble.heard').last();
	await expect(heard).toBeVisible();
	await expect(page.locator('.turn.bot .bubble').last()).toHaveText(
		/You said: |I did not catch that|Nothing was said/,
		{ timeout: 15_000 }
	);
});

test('the settings sheet says what runs, and history says what was done', async ({ page }, info) => {
	await paired(page);
	await page.click('#openSettings');
	const sheet = page.locator('#settings');
	await expect(sheet).toBeVisible();
	await expect(sheet.locator('dd').nth(2)).toHaveText('fake');
	await expect(sheet.locator('dd').nth(5)).toHaveText(/\d+ \/ \d+/);
	await page.screenshot({ path: join(SHOTS, `${info.project.name}-settings.png`) });
	await page.click('#showHistory');
	const history = page.locator('#history');
	await expect(history).toBeVisible();
	await expect(history.locator('li').first()).toContainText('›');
	await page.click('#closeHistory');
	await expect(history).toBeHidden();
});

test('dark theme', async ({ page }, info) => {
	await page.emulateMedia({ colorScheme: 'dark' });
	await paired(page);
	await page.fill('#text', 'what is on today');
	await page.press('#text', 'Enter');
	await expect(page.locator('.turn.bot .bubble').last()).toHaveText(/Today you have/);
	await page.screenshot({ path: join(SHOTS, `${info.project.name}-dark.png`), fullPage: true });
});

test('forgetting the phone takes two presses, the second not too soon', async ({ page }) => {
	await paired(page);
	await page.click('#openSettings');
	await page.click('#forget');
	const really = page.locator('#forgetReally');
	await expect(really).toBeVisible();
	await really.click();
	await expect(page.locator('#settings')).toBeVisible();
	await page.waitForTimeout(500);
	await really.click();
	await expect(page.locator('#pairForm')).toBeVisible();
});
