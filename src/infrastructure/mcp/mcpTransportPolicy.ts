// src/infrastructure/mcp/mcpTransportPolicy.ts — MCP SSRF 防护：初始目标、每跳 redirect、DNS 解析地址全部校验
import { isIP } from 'node:net';

const privateIp = (ip: string) => /^(127\.|10\.|0\.|169\.254\.|192\.168\.|::1$|fc|fd)/i.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

export class McpTransportPolicy {
  constructor(private readonly dns: { resolve(host: string): Promise<string[]> }) {}
  async assertHttpTarget(url: URL): Promise<void> {
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || ['localhost','localhost.'].includes(url.hostname))
      throw Object.assign(new Error('blocked MCP target'), { code: 'MCP_SSRF_BLOCKED' });
    const addresses = isIP(url.hostname) ? [url.hostname] : await this.dns.resolve(url.hostname);
    if (!addresses.length || addresses.some(privateIp)) throw Object.assign(new Error('blocked MCP address'), { code: 'MCP_SSRF_BLOCKED' });
  }
  async assertRedirect(_from: URL, to: URL): Promise<void> { await this.assertHttpTarget(to); }
}
