import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runtime = process.env.GCA_PLAYWRIGHT_DIR;
const site = 'http://localhost:8080';
const cloud = 'http://localhost:54321';
const media = { html: 'text/html', mjs: 'application/javascript', css: 'text/css' };

test('a browser plays two synthetic sessions, retries a lost response and sees the instructor timeline', { skip: !runtime }, async () => {
  const { chromium } = await import(runtime + '/index.mjs');
  const browser = await chromium.launch({ executablePath: process.env.GCA_CHROME });
  const sessions = new Map();
  const received = new Map();
  const runs = [];
  let losingBatch;

  async function setup(context) {
    await context.route(site + '/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/analytics/config.mjs') {
        return route.fulfill({
          contentType: media.mjs,
          body: `export const config = {url: '${cloud}', publishableKey:'sb_publishable_testing'};`,
        });
      }
      const extension = pathname.split('.').at(-1);
      if (!media[extension]) return route.fulfill({ status: 404 });
      const body = await readFile(new URL('..' + pathname, import.meta.url));
      await route.fulfill({ status: 200, contentType: media[extension], body });
    });
    await context.route(cloud + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const input = request.postDataJSON() || {};
      const headers = { 'access-control-allow-origin': site, 'access-control-allow-headers': 'apikey, authorization, content-type' };
      const answer = json => route.fulfill({ status: 200, json, headers });
      if (path === '/auth/v1/signup') {
        const id = 'mock-' + (Math.random() + 1).toString(36).slice(2);
        return answer({ user: { id }, expires_in: 3600, access_token: id, refresh_token: id });
      }
      if (path === '/auth/v1/token') {
        return answer({ user: { id: 'teacher' }, expires_in: 3600, access_token: 'teacher', refresh_token: 'teacher' });
      }
      if (path.endsWith('/gca_enroll')) {
        sessions.set(input.p_session, input.p_name);
        return answer({ session_id: input.p_session, rounds_required: 1, resolved_rounds: 0, completed_at: null });
      }
      if (path.endsWith('/gca_ingest')) {
        const batch = input.p_events;
        const id = input.p_session;
        const records = received.get(id) ?? new Map();
        received.set(id, records);
        for (const e of batch) records.set(e.event_id, e);
        runs.push(batch.map(e => e.event_id));
        if (!losingBatch && batch.some(e => e.type === 'round_resolved')) {
          losingBatch = runs.at(-1);
          return route.abort('failed');
        }
        const done = [...records.values()].some(e => e.type === 'round_resolved');
        return answer({ acknowledged: runs.at(-1), rounds_required: 1, resolved_rounds: Number(done), completed_at: done ? '2026-11-25T00:00:00Z' : null });
      }
      if (path.endsWith('/gca_classes')) {
        return answer([{ id: 'class', label: 'Synthetic classroom', rounds_required: 1, is_open: true }]);
      }
      if (path.endsWith('/gca_sessions')) {
        return answer([...sessions].map(([session_id, student_name]) => ({
          session_id, student_name, participant_id: session_id, partner_name: '', completed_at: '2026-11-25T00:00:00Z',
          resolved_rounds: 1, abandoned_rounds: 0, restarts: 0, human_moves: 2, computer_moves: 1,
          sequences: [{ cards: ['ghost', 'leave', 'ghost'], heads: 1, tails: 0 }],
        })));
      }
      if (path.endsWith('/gca_events')) {
        const events = [...received.get(input.p_session).values()].filter(e => e.seq > input.p_after);
        return answer(events.slice(0, 200).map(e => ({ ...e, event_type: e.type })));
      }
      return route.fulfill({ status: 404, json: { message: 'Unexpected route ' + path }, headers });
    });
  }

  try {
    const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await setup(publicContext);
    const publicPage = await publicContext.newPage();
    await publicPage.goto(site + '/games/ghost-coin.html?solo=1');
    assert.equal(await publicPage.locator('#gca-classroom').isHidden(), true);
    await publicPage.getByRole('button', { name: 'Ghost: Split into both boxes' }).tap();
    await publicPage.getByRole('button', { name: 'Ghost: Split into both boxes' }).tap();
    await publicPage.getByText('Player A wins!', { exact: false }).last().waitFor();
    assert.equal(sessions.size, 0);
    await publicContext.close();

    for (const name of ['Synthetic Alice', 'Synthetic Bob']) {
      const studentContext = await browser.newContext();
      await setup(studentContext);
      const page = await studentContext.newPage();
      await page.goto(site + '/games/ghost-coin.html?classroom=1');
      await page.getByLabel('Class code').fill('1234ABCD1234ABCD');
      await page.getByLabel('Your name').fill(name);
      await page.getByRole('button', { name: 'Join class' }).click();
      await page.locator('#gca-enrollment').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Chip lab' }).click();
      await page.getByRole('button', { name: 'Ghost: Split into both boxes' }).click();
      await page.getByRole('button', { name: 'Play the game' }).click();
      await page.getByRole('button', { name: 'Solo quick play' }).click();
      await page.locator('body').press('g');
      await page.waitForFunction(() => !document.querySelector('#hand button')?.disabled && document.querySelector('#hand-title').textContent.includes('Player A'));
      await page.locator('body').press('g');
      await page.getByText('Completion credit saved.', { exact: true }).waitFor();
      await page.getByText('Activity saved.', { exact: true }).waitFor();
      const id = [...sessions].find(([, n]) => n === name)[0];
      const events = [...received.get(id).values()];
      assert.equal(events.filter(e => e.type === 'round_resolved').length, 1);
      assert.deepEqual(events.filter(e => e.type === 'card_played').map(e => e.payload.actor), ['human', 'computer', 'human']);
      assert.equal(events.filter(e => e.type === 'level_exit').length, 1);
      assert.equal(events.filter(e => e.type === 'level_enter').length, 2);
      assert.equal(events.filter(e => e.type === 'completion_reached').length, 1);
      assert.ok(events.every(e => !JSON.stringify(e).includes(name)));
      await studentContext.close();
    }
    assert.ok(runs.filter(seq => JSON.stringify(seq) === JSON.stringify(losingBatch)).length >= 2);

    const staff = await browser.newContext();
    await setup(staff);
    const teacher = await staff.newPage();
    await teacher.goto(site + '/instructor.html');
    await teacher.getByLabel('Email', { exact: true }).fill('synthetic@teacher.example');
    await teacher.getByLabel('Password').fill('local-demo-only');
    await teacher.getByRole('button', { name: 'Sign in', exact: true }).click();
    await teacher.locator('#dashboard').waitFor({ state: 'visible', timeout: 5000 }).catch(async error => {
      throw new Error(`Dashboard sign-in did not finish: ${await teacher.locator('#status').textContent()}`, { cause: error });
    });
    await teacher.locator('#class-select').selectOption('class');
    await teacher.getByRole('button', { name: 'View timeline for Synthetic Alice' }).click();
    await teacher.getByRole('heading', { name: 'Synthetic Alice' }).waitFor();
    await teacher.getByText('round resolved', { exact: true }).waitFor();
    const download = teacher.waitForEvent('download');
    await teacher.getByRole('button', { name: 'Export class summary' }).click();
    const file = await download;
    assert.equal(file.suggestedFilename(), 'ghost-coin-summary.csv');
    const contents = await readFile(await file.path(), 'utf8');
    assert.match(contents, /Synthetic Alice/);
    assert.match(contents, /Synthetic Bob/);

    const cardDownload = teacher.waitForEvent('download');
    await teacher.getByRole('button', { name: 'Export card plays' }).click();
    const cardFile = await cardDownload;
    assert.equal(cardFile.suggestedFilename(), 'ghost-coin-card-plays.csv');
    const cards = await readFile(await cardFile.path(), 'utf8');
    const [header, ...plays] = cards.trimEnd().split('\r\n');
    assert.match(header, /"turn","player","actor","card","before_heads","before_tails","after_heads","after_tails"/);
    assert.equal(plays.length, 6);
    assert.equal(plays.filter(row => row.includes('"2","B","computer"')).length, 2);
    assert.ok(plays.every(row => row.endsWith('"resolved","1","H"')));
    assert.doesNotMatch(cards, /Synthetic Alice|Synthetic Bob/);

    await teacher.getByRole('button', { name: 'View quantitative report' }).click();
    const report = teacher.getByRole('region', { name: 'Quantitative class report' });
    await report.waitFor();
    assert.deepEqual(await report.locator('dd').allTextContents(), ['2', '4', '2', '2 / 2']);
    assert.equal(await report.locator('.report-bar-row').count(), 4);
    await report.getByText('Ghost', { exact: true }).waitFor();
    await report.getByText('Human 4 · Computer 0', { exact: true }).waitFor();
    await report.getByText('Automatic reveal (2)', { exact: true }).waitFor();
    await report.getByText('Heads probability', { exact: true }).waitFor();
    assert.equal(await report.locator('tbody tr').count(), new Set([...received.values()].map(events =>
      [...events.values()].find(e => e.type === 'round_resolved').payload.cards.join(',')
    )).size);
    await teacher.locator('#class-select').selectOption('');
    await report.waitFor({ state: 'hidden' });
    await staff.close();
  } finally {
    await browser.close();
  }
});
