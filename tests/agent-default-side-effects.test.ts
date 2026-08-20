import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const agentSource = (): string => readFileSync(resolve('src/kernel/agent.ts'), 'utf8');

describe('P0-4 implicit side-effect guard', () => {
  it('通用 Agent 工具链不得自动 stage、commit 或绕过 hooks', () => {
    const source = agentSource();
    expect(source).not.toContain('maybeAutoGitCommit');
    expect(source).not.toContain("['commit'");
    expect(source).not.toContain("['add'");
    expect(source).not.toContain('--no-verify');
  });

  it('危险或外部工具成功后不得隐式截取桌面', () => {
    const source = agentSource();
    expect(source).not.toContain("import('./computer/index.js')");
    expect(source).not.toContain('敏感操作已截图留证');
    expect(source).not.toContain("join(agentDataDir, 'captures')");
  });
});
