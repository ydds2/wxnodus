// tests/delegate-manager-wiring.test.ts — source/dist child command and workspace propagation
import { describe, expect, it } from 'vitest';
import { resolveDelegateSpawnSpec } from '../src/infrastructure/autonomy/delegateManagerWiring.js';

describe('delegate manager production spawn specification', () => {
  const common = {
    goal: 'inspect repository',
    cwd: 'C:\\work tree\\delegate-1',
    dataDir: 'C:\\wxnodus data',
    sessionId: 'session-1',
    env: { PATH: 'test-path' },
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
  };

  it('uses the project-local tsx runner for source execution', () => {
    const spec = resolveDelegateSpawnSpec({
      ...common,
      moduleUrl: 'file:///C:/repo/src/infrastructure/autonomy/delegateManagerWiring.ts',
    });

    expect(spec.command).toBe(common.execPath);
    expect(spec.args[0]).toMatch(/node_modules[\\/]tsx[\\/]dist[\\/]cli\.mjs$/);
    expect(spec.args[1]).toMatch(/src[\\/]cli[\\/]index\.ts$/);
    expect(spec.args.slice(2)).toEqual([
      '-p', common.goal, '--workspace', common.cwd, '--session', common.sessionId,
    ]);
    expect(spec.cwd).toBe(common.cwd);
    expect(spec.env).toMatchObject({
      PATH: 'test-path',
      WXNODUS_WORKSPACE: common.cwd,
      WXNODUS_DATA_DIR: common.dataDir,
    });
  });

  it('uses the compiled sibling CLI for dist execution', () => {
    const spec = resolveDelegateSpawnSpec({
      ...common,
      moduleUrl: 'file:///C:/repo/dist/infrastructure/autonomy/delegateManagerWiring.js',
    });

    expect(spec.args).toEqual([
      expect.stringMatching(/dist[\\/]cli[\\/]index\.js$/),
      '-p', common.goal, '--workspace', common.cwd, '--session', common.sessionId,
    ]);
  });
});
