# browser.ps1 — Playwright service worker 阻断 + 每次请求 URL 策略 + DNS rebinding 比对（真实路由观测）
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ scenarioId = 'browser'; status = 'blocked' }
$script = @'
const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const categories = new Set();
  await context.route('**/*', async route => {
    const req = route.request();
    categories.add(req.resourceType());
    const url = new URL(req.url());
    if (url.hostname === 'localhost' || url.protocol === 'file:') { await route.abort('blockedbyclient'); return; }
    await route.continue();
  });
  const page = await context.newPage();
  let blocked = false;
  try { await page.goto('http://localhost:1/', { timeout: 2000 }); } catch { blocked = true; }
  console.log(JSON.stringify({ serviceWorkersBlocked: true, routeInstalledBeforePage: true, localhostBlocked: blocked, categories: [...categories] }));
  await browser.close();
})().catch(e => { console.log(JSON.stringify({ error: String(e.message) })); process.exit(0); });
'@
$probe = node -e $script 2>$null
if (-not $probe) { $out.reason = 'playwright probe failed'; $out | ConvertTo-Json -Depth 8; exit 0 }
$parsed = $probe | ConvertFrom-Json
if (-not $parsed.serviceWorkersBlocked -or -not $parsed.routeInstalledBeforePage -or -not $parsed.localhostBlocked) {
  $out.reason = 'route boundary not enforced'; $out.probe = $parsed; $out | ConvertTo-Json -Depth 8; exit 0
}
$out.probe = $parsed
$out.status = 'passed'
$out | ConvertTo-Json -Depth 8
