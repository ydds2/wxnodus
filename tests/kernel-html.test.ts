// tests/kernel-html.test.ts — 共享 HTML 实体解码 / 正文抽取（搜索与 /claw 共用）
import { describe, expect, it } from 'vitest'

import { decodeHtmlEntities, extractMainText, htmlToText, looksLikeHtml } from '../src/kernel/html.js'

describe('decodeHtmlEntities — 完整实体解码', () => {
  it('命名实体', () => {
    expect(decodeHtmlEntities('a &amp; b &lt;tag&gt; &quot;q&quot; &apos;x&apos;')).toBe('a & b <tag> "q" \'x\'')
  })

  it('数字字符引用（截图乱码根因：&#236; → ì）', () => {
    expect(decodeHtmlEntities('z&#236; x&#237;ng')).toBe('zì xíng')
  })

  it('十六进制引用（&#x4e2d; → 中）', () => {
    expect(decodeHtmlEntities('&#x4e2d;&#x6587;')).toBe('中文')
    expect(decodeHtmlEntities('&#X41;')).toBe('A')
  })

  it('递归解码双层编码（Bing &amp;#236; → &#236; → ì）', () => {
    expect(decodeHtmlEntities('&amp;#236;')).toBe('ì')
    expect(decodeHtmlEntities('&amp;amp;#236;')).toBe('ì')
  })

  it('无分号数字引用', () => {
    expect(decodeHtmlEntities('&#236')).toBe('ì')
  })

  it('无效实体原样保留（&unknown;、裸 &）', () => {
    expect(decodeHtmlEntities('&unknown; & &T')).toBe('&unknown; & &T')
  })

  it('安全过滤：控制字符/代理区/超上限不崩溃', () => {
    expect(decodeHtmlEntities('&#0;&#8;&#55296;&#1114112;')).toBe('&#0;&#8;&#55296;&#1114112;')
    expect(decodeHtmlEntities('a&#9;b&#10;c')).toBe('a\tb\nc')
  })

  it('高频符号实体', () => {
    expect(decodeHtmlEntities('&middot; &hellip; &mdash; &nbsp;x')).toBe('· … —  x')
  })
})

describe('htmlToText — HTML 正文抽取', () => {
  it('去标签/脚本/样式/注释 + 实体解码', () => {
    const html = '<html><head><style>body{color:red}</style></head><body><script>alert(1)</script><!-- c --><h1>标题 &amp; 内容</h1><p>拼音 z&#236; x&#237;ng</p></body></html>'
    expect(htmlToText(html)).toBe('标题 & 内容 拼音 zì xíng')
  })

  it('空白归一', () => {
    expect(htmlToText('<p>a</p>  \n <p>b</p>')).toBe('a b')
  })

  it('maxLen 截断', () => {
    expect(htmlToText('一二三四五六', 4)).toBe('一二三四')
  })

  it('空/非 HTML 输入', () => {
    expect(htmlToText('')).toBe('')
    expect(htmlToText('plain text')).toBe('plain text')
  })
})

describe('looksLikeHtml — 启发式判断', () => {
  it('DOCTYPE / html 根 / 成对块级标签', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html></html>')).toBe(true)
    expect(looksLikeHtml('<div class="x"><p>hi</p></div>')).toBe(true)
    expect(looksLikeHtml('{"a":1,"p":"x"}')).toBe(false)
    expect(looksLikeHtml('plain text')).toBe(false)
  })
})

describe('extractMainText — readability 式正文提取（P0-4 搜索即读）', () => {

  it('剥离 nav/footer/script 噪音，保留正文段落', () => {
    const html = `
      <html><head><script>var a=1;</script><style>.x{}</style></head><body>
      <nav><a>首页</a><a>关于</a><a>登录</a></nav>
      <article>
        <h1>今天的重要新闻</h1>
        <p>今天上午，某科技公司发布了一款新产品，引发市场广泛关注。</p>
        <p>分析师认为，该产品有望改变行业格局，未来前景值得期待。</p>
      </article>
      <footer>版权所有 · 联系我们 · 隐私政策</footer>
      </body></html>`;
    const text = extractMainText(html);
    expect(text).toContain('今天的重要新闻');
    expect(text).toContain('某科技公司发布了一款新产品');
    expect(text).not.toContain('首页');
    expect(text).not.toContain('版权所有');
    expect(text).not.toContain('var a');
  });

  it('实体解码（&#236; / &amp;）', () => {
    const text = extractMainText('<p>&amp;#236; 号字体渲染测试</p>');
    expect(text).toContain('ì');
  });

  it('空输入/纯噪音返回空', () => {
    expect(extractMainText('')).toBe('');
    expect(extractMainText('<script>x</script><style>y</style>')).toBe('');
  });

  it('maxLen 预算内输出', () => {
    const long = '<p>' + '正文内容'.repeat(500) + '</p>';
    expect(extractMainText(long, 100).length).toBeLessThanOrEqual(100);
  });
});
