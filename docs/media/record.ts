// Records docs/media/loop.gif: the knowledge loop on the demo shop, as the quickstart walks it.
// Needs the GUI built and a throwaway engine + demo shop:
//   pnpm --filter @tc/desktop build && node tests/e2e/serve.ts   # in one terminal
//   node docs/media/record.ts                                     # in another (needs ffmpeg)
import { chromium, type Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = `http://127.0.0.1:${process.env.TC_E2E_PORT ?? 4319}/`;
const out = join(import.meta.dirname, 'loop.gif');
const frames = await mkdtemp(join(tmpdir(), 'tc-frames-'));
const FPS = 6;

const browser = await chromium.launch();
// Scripted agents: the recording must not depend on anyone's sign-in.
const setup = await browser.newPage();
await setup.goto(url);
await setup.getByRole('button', { name: 'Settings' }).click();
await setup.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Agents/ }).click();
await setup.getByLabel('Provider').first().selectOption('');
await setup.getByRole('button', { name: 'Save settings' }).click();
await setup.waitForTimeout(500);
await setup.close();

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url);
// A cursor and a caption, so the GIF reads without sound.
await page.evaluate(() => {
  const el = (css: string) => Object.assign(document.body.appendChild(document.createElement('div')), { style: css });
  el('position:fixed;z-index:99999;left:640px;top:400px;width:18px;height:18px;border-radius:50%;background:rgba(220,40,40,.75);border:2px solid #fff;pointer-events:none;transition:left .5s,top .5s').id = 'rec-cursor';
  el('position:fixed;z-index:99999;left:50%;bottom:24px;transform:translateX(-50%);padding:10px 18px;border-radius:8px;background:rgba(20,24,28,.88);color:#fff;font:600 20px system-ui;pointer-events:none').id = 'rec-caption';
});

let n = 0;
const frame = () => page.screenshot({ path: join(frames, `${String(n++).padStart(5, '0')}.png`) });
async function hold(seconds: number) {
  for (let i = 0; i < seconds * FPS; i++) await frame();
}
async function caption(text: string) {
  await page.evaluate((t) => (document.getElementById('rec-caption')!.textContent = t), text);
}
async function click(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.evaluate(([x, y]) => Object.assign(document.getElementById('rec-cursor')!.style, { left: `${x}px`, top: `${y}px` }), [box.x + box.width / 2 - 9, box.y + box.height / 2 - 9]);
  await hold(0.7);
  await target.click();
}
const nav = (name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: new RegExp(`^${name}`) });
async function scroll(y: number) {
  await page.locator('.page').evaluate((e, y) => e.scrollTo({ top: y, behavior: 'smooth' }), y);
  await hold(0.8);
}

await nav('Sources').click();
await caption('1 · Sources: docs, tracker export, code — check that agents can read them');
await hold(1);
await click(page.getByRole('button', { name: 'Check access' }));
await hold(2.5);

await caption('2 · Model: ask your agent to review it against the sources');
await click(nav('Model'));
await hold(1.5);
await click(page.getByRole('button', { name: 'Ask agent' }));
await click(page.getByRole('menuitem', { name: /Review the model/ }));
await page.getByText('review — done').waitFor({ timeout: 60_000 });
await caption('Findings land on the model, with a dashed border');
await hold(2);
await click(page.getByRole('button', { name: /^Cancel/ }).first());
await caption('Each rule comes with quotes: ✓ true · ≈ observed · ⏳ planned · ✕ strike out');
// The agent's rule on Cancel, quoted from the product overview: the last ✓ on the page.
const accept = page.getByRole('button', { name: '✓' }).last();
await accept.scrollIntoViewIfNeeded();
await hold(3);
await click(accept);
await hold(2);

await caption('3 · Disagreements: requirements say one thing, the code another');
await click(nav('Inbox'));
await hold(3.5);
await click(page.getByRole('button', { name: 'Bug in the product' }).first());
await hold(1.5);

await caption('4 · Specification: the confirmed model, with sources for every rule');
await click(nav('Spec'));
await hold(2);
await scroll(700);
await hold(1.5);

await caption('5 · Tests: Playwright, generated from the same model');
await click(nav('Tests'));
await click(page.getByRole('button', { name: 'Run all tests' }));
await hold(2);
await page.getByRole('button', { name: 'Run all tests' }).waitFor({ timeout: 600_000 });
await caption('Every failure is a disagreement to settle — and the loop goes on');
await hold(4);

await browser.close();
// Two-pass palette keeps the GIF small and the text crisp.
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.png'),
  '-vf', `scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=none`, out]);
await rm(frames, { recursive: true, force: true });
console.log(`wrote ${out} (${n} frames)`);
