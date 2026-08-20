// tests/kernel-search.test.ts — A20 自研联网搜索：DDG HTML 解析器（fixture，不发真实网络）
import { afterEach, describe, expect, it, vi } from 'vitest'

import { decodeDdgUrl, parseBingHtml, parseDuckDuckGoHtml, searchWeb } from '../src/kernel/search.js'

// P0-08：searchWeb 走 outboundTargetPolicy（DNS fail-closed）——fixture 固定搜索域名解析，避免依赖真实网络
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string, options: { all?: boolean }) => {
    if (host === 'html.duckduckgo.com' || host === 'www.bing.com' || host === 'example.com') {
      return options.all ? [{ address: '93.184.216.34' }] : '93.184.216.34';
    }
    throw new Error('ENOTFOUND');
  }),
}));

// DDG HTML 结果页 fixture（真实结构：result__a + result__snippet）
const FIXTURE_HTML = `
<html><body>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">Example Docs &amp; Guide</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">这是摘要文本，介绍 Example 文档的用法与 API 参考。</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://direct.example.org/page">直接链接标题</a>
  </h2>
  <a class="result__snippet" href="https://direct.example.org/page">第二个结果的摘要，无跳转参数。</a>
</div>
</body></html>
`

describe('decodeDdgUrl — 跳转解码', () => {
  it('uddg 参数解码为目标 URL', () => {
    expect(decodeDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc')).toBe(
      'https://example.com/docs'
    )
  })

  it('无 uddg 的普通链接原样返回', () => {
    expect(decodeDdgUrl('https://direct.example.org/page')).toBe('https://direct.example.org/page')
  })

  it('协议相对链接补 https', () => {
    expect(decodeDdgUrl('//example.com/x')).toBe('https://example.com/x')
  })
})

describe('parseDuckDuckGoHtml — 结果解析', () => {
  it('解析标题/URL/摘要（8 条上限）', () => {
    const results = parseDuckDuckGoHtml(FIXTURE_HTML)
    expect(results.length).toBe(2)
    expect(results[0]).toEqual({
      title: 'Example Docs & Guide',
      url: 'https://example.com/docs',
      snippet: '这是摘要文本，介绍 Example 文档的用法与 API 参考。'
    })
    expect(results[1]!.title).toBe('直接链接标题')
    expect(results[1]!.url).toBe('https://direct.example.org/page')
  })

  it('HTML 实体解码（&amp; → &）', () => {
    const r = parseDuckDuckGoHtml(FIXTURE_HTML)
    expect(r[0]!.title).toContain('&')
  })

  it('无结果页返回空数组（诚实提示由调用方给出）', () => {
    expect(parseDuckDuckGoHtml('<html><body>no results</body></html>')).toEqual([])
    expect(parseDuckDuckGoHtml('')).toEqual([])
  })

  it('跳过空标题与残留跳转链接', () => {
    const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com&rut=1">   </a>'
    expect(parseDuckDuckGoHtml(html)).toEqual([])
  })
})

describe('parseBingHtml — Bing 回退引擎解析', () => {
  const BING_FIXTURE = `
<ol id="b_results">
<li class="b_algo">
  <h2><a href="https://example.com/bing-page?q=1&amp;lang=zh">Bing 结果标题</a></h2>
  <div class="b_caption"><p>这是 Bing 摘要，说明页面内容。</p></div>
</li>
<li class="b_algo">
  <h2><a href="https://example.org/second">第二条标题</a></h2>
  <div class="b_caption"><p>第二条摘要。</p></div>
</li>
</ol>`

  it('解析 b_algo 块（标题/URL/摘要）', () => {
    const results = parseBingHtml(BING_FIXTURE)
    expect(results.length).toBe(2)
    expect(results[0]).toEqual({
      title: 'Bing 结果标题',
      url: 'https://example.com/bing-page?q=1&lang=zh',
      snippet: '这是 Bing 摘要，说明页面内容。'
    })
    expect(results[1]!.title).toBe('第二条标题')
  })

  it('URL 实体解码（&amp; → &）', () => {
    const r = parseBingHtml(BING_FIXTURE)
    expect(r[0]!.url).toBe('https://example.com/bing-page?q=1&lang=zh')
    expect(r[0]!.url).not.toContain('&amp;')
  })

  it('标题数字实体解码（&#236; → ì）', () => {
    const html = '<li class="b_algo"><h2><a href="https://example.com/z">拼音 z&#236; x&#237;ng</a></h2><div class="b_caption"><p>摘要</p></div></li>'
    expect(parseBingHtml(html)[0]!.title).toBe('拼音 zì xíng')
  })

  it('摘要时间戳噪声清理（「8 小时之前 ·」前缀）', () => {
    const html = '<li class="b_algo"><h2><a href="https://example.com/t">标题</a></h2><div class="b_caption"><p>8 小时之前 · 网络解释 1. 拼音zì xíng</p></div></li>'
    expect(parseBingHtml(html)[0]!.snippet).toBe('网络解释 1. 拼音zì xíng')
  })

  it('按 URL 去重', () => {
    const html = `<li class="b_algo"><h2><a href="https://example.com/dup">一</a></h2><div class="b_caption"><p>a</p></div></li>
<li class="b_algo"><h2><a href="https://example.com/dup">二</a></h2><div class="b_caption"><p>b</p></div></li>`
    const r = parseBingHtml(html)
    expect(r.length).toBe(1)
    expect(r[0]!.title).toBe('一')
  })

  it('非 http 链接跳过；无结果空数组', () => {
    expect(parseBingHtml('<li class="b_algo"><h2><a href="javascript:void(0)">x</a></h2></li>')).toEqual([])
    expect(parseBingHtml('<html>no results</html>')).toEqual([])
  })
})

describe('searchWeb — P0-3 搜索缓存', () => {
  const DDG_OK = `<a rel="nofollow" class="result__a" href="https://example.com/a">缓存测试标题</a>
<a class="result__snippet" href="https://example.com/a">缓存摘要</a>`

  function stubFetchOk() {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      // P0-08：safeFetchText 消费 ReadableStream body + headers.get（bounded reader 契约）
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        body: new ReadableStream({
          start(controller) { controller.enqueue(Buffer.from(DDG_OK)); controller.close(); },
        }),
      } as any
    }))
    return () => calls
  }

  afterEach(() => vi.unstubAllGlobals())

  it('同查询 5 分钟内命中缓存：第二次不发起网络请求', async () => {
    const count = stubFetchOk()
    const q = `缓存查询${Date.now()}`
    const r1 = await searchWeb(q, { maxResults: 3 })
    expect(r1.ok).toBe(true)
    expect(count()).toBe(1)

    const r2 = await searchWeb(q, { maxResults: 3 })
    expect(r2.ok).toBe(true)
    expect(count()).toBe(1) // 缓存命中——不再请求
    expect(r2.ok && r2.results[0]!.title).toBe('缓存测试标题')
  })

  it('不同查询词不共享缓存', async () => {
    const count = stubFetchOk()
    await searchWeb(`甲${Date.now()}`)
    await searchWeb(`乙${Date.now()}`)
    expect(count()).toBe(2)
  })
})
