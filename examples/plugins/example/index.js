// 示例插件实现（ESM 模块）
// 导出 tools（工具 handler）与 commands（插件命令 handler）
export const tools = {
  example_greet: async (args, ctx) => {
    const lang = args?.lang === 'en' ? `Hello, ${args?.name ?? 'world'}!` : `你好，${args?.name ?? '世界'}！`
    return `${lang}（插件数据目录：${ctx.dataPath}）`
  },
  example_echo: async (args) => String(args?.text ?? ''),
}

export const commands = {
  // 注册为 /example.hello <参数...>
  hello: async (args) => `示例插件命令：收到 ${args.length ? args.join(' ') : '（空参数）'}`,
}
