// End-to-end tests of index.html in a real browser.
const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.beforeEach(({ page }) => {
  page.on('pageerror', err => { throw err; });
});

test('landing page without #file', async ({ page }) => {
  await page.goto('index.html');
  await expect(page.locator('h1')).toHaveText('Trajectory Viewer');
  await expect(page.locator('#drop')).toBeVisible();
});

test('renders the ATIF example', async ({ page }) => {
  await page.goto('index.html#file=examples/atif-example.json');
  await expect(page.locator('.traj-header h1')).toContainText('example-agent 1.0.0 · claude-opus-5-5');
  await expect(page.locator('#trajectory > .steps > .step')).toHaveCount(7);
  await expect(page.locator('.chip', { hasText: 'tool calls' })).toContainText('4');
  await expect(page.locator('.chip', { hasText: 'cost' })).toContainText('$0.0086');
  // multimodal image resolved relative to the trajectory URL
  const img = page.locator('#step-2 img.img-part');
  await expect(img).toHaveAttribute('src', /examples\/images\/screenshot\.png$/);
  expect(await img.evaluate(i => i.complete && i.naturalWidth)).toBe(64);
  // markdown rendering
  await expect(page.locator('#step-2 strong')).toHaveText('fix');
  await expect(page.locator('#step-7 table td').first()).toHaveText('calc.py');
  // tool call paired with its observation, ANSI colored, error flagged
  const call = page.locator('#step-3 .call');
  await expect(call.locator('.fn')).toContainText('bash');
  await expect(call.locator('pre').first()).toHaveText('$ pytest -q tests/test_calc.py');
  await expect(call.locator('.out.error')).toContainText('1 failed');
  await expect(call.locator('.out span.ansi').first()).toHaveCSS('color', /rgb/);
  // edit rendered as diff
  await expect(page.locator('#step-4 .diff .del')).toHaveCount(2);
  await expect(page.locator('#step-4 .diff .add').last()).toHaveText('+     return a + b');
  // reasoning
  await expect(page.locator('#step-3 .reasoning')).toContainText('run the failing test');
});

test('embedded subagent trajectory expands on demand', async ({ page }) => {
  await page.goto('index.html#file=examples/atif-example.json');
  const sub = page.locator('#step-5 details.subagent');
  await expect(sub.locator('summary')).toContainText('reviewer-1');
  await expect(sub).not.toContainText('SUBAGENT_VERDICT');
  await sub.locator('summary').click();
  await expect(sub).toContainText('SUBAGENT_VERDICT: no other operator mistakes found.');
  await expect(sub.locator('.step')).toHaveCount(3);
});

test('renders the Claude Code JSONL example', async ({ page }) => {
  await page.goto('index.html#file=examples/claude-code-example.jsonl');
  await expect(page.locator('.traj-header .sub')).toContainText('converted from Claude Code JSONL');
  await expect(page.locator('#trajectory > .steps > .step')).toHaveCount(5);
  await expect(page.locator('#step-2 .fn')).toContainText('Bash');
  await expect(page.locator('#step-2 .out.error')).toContainText('1 failed, 4 passed');
  await expect(page.locator('#step-3 .diff .add')).toHaveText('+ return a + b');
  expect(await page.locator('#step-4 img.img-part').evaluate(i => i.naturalWidth)).toBe(8);
  await expect(page.locator('#step-5')).toContainText('CC_FINAL: all 5 tests pass now.');
  await expect(page).toHaveTitle(/Fix the failing test/);
});

test('toolbar toggles and filter', async ({ page }) => {
  await page.goto('index.html#file=examples/atif-example.json');
  await expect(page.locator('#step-3 .out')).toBeVisible();
  await page.getByLabel('tool outputs').uncheck();
  await expect(page.locator('#step-3 .out')).toBeHidden();
  await page.getByLabel('system steps').uncheck();
  await expect(page.locator('#step-1')).toBeHidden();
  await page.getByPlaceholder('Filter steps…').fill('subagent');
  await expect(page.locator('#trajectory > .steps > .step:visible')).toHaveCount(1);
});

test('step permalink', async ({ page }) => {
  await page.goto('index.html#file=examples/atif-example.json&step=6');
  await expect(page.locator('#step-6')).toHaveClass(/target/);
  await page.locator('#step-4 [data-permalink]').click();
  expect(page.url()).toContain('step=4');
  await expect(page.locator('#step-4')).toHaveClass(/target/);
  await expect(page.locator('#step-6')).not.toHaveClass(/target/);
});

test('local file via file picker', async ({ page }) => {
  await page.goto('index.html');
  await page.locator('#file-input').setInputFiles(path.join(__dirname, '..', 'examples', 'claude-code-example.jsonl'));
  await expect(page.locator('#trajectory > .steps > .step')).toHaveCount(5);
});

test('fetch error is reported', async ({ page }) => {
  await page.goto('index.html#file=examples/does-not-exist.json');
  await expect(page.locator('#error')).toContainText('HTTP 404');
});

test('unrecognized content is reported', async ({ page }) => {
  await page.goto('index.html#file=AGENTS.md');
  await expect(page.locator('#error')).toContainText('Unrecognized trajectory format');
});

test('untrusted trajectory content cannot run scripts', async ({ page }) => {
  const evil = JSON.stringify({
    schema_version: 'ATIF-v1.7', agent: { name: '<img src=x onerror="window.pwned=1">', version: '1' },
    steps: [
      { step_id: 1, source: 'user', message: 'hi <img src=x onerror="window.pwned=2"> <script>window.pwned=3</script>' },
      { step_id: 2, source: 'agent', message: '[x](javascript:window.pwned=4)', tool_calls: [
        { tool_call_id: '<b>', function_name: '<img src=x onerror="window.pwned=5">', arguments: { command: '<img src=x onerror="window.pwned=6">' } }] },
    ],
  });
  await page.route('**/evil.json', r => r.fulfill({ body: evil, contentType: 'application/json' }));
  await page.goto('index.html#file=evil.json');
  await expect(page.locator('#trajectory > .steps > .step')).toHaveCount(2);
  await page.locator('#step-2 a').first().click().catch(() => {});
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});
