// src/bootstrap/createApplication.ts — 可回收组合根：固定五阶段装配，失败只 dispose 已启动资源
import { bootstrapConfig } from './bootstrapConfig.js';
import { bootstrapExtensions } from './bootstrapExtensions.js';
import { bootstrapKernel } from './bootstrapKernel.js';
import { bootstrapPresentation } from './bootstrapPresentation.js';
import { bootstrapRepositories } from './bootstrapRepositories.js';
import { createShutdown } from './bootstrapShutdown.js';
import type { ApplicationInstance, BootstrapOptions, BootstrapPhaseName, BootstrapResource, BootstrapState } from './bootstrapTypes.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';

const ORDER: BootstrapPhaseName[] = ['config', 'repositories', 'kernel', 'extensions', 'presentation'];

export async function createApplication(options: BootstrapOptions): Promise<OperationResult<ApplicationInstance>> {
  const state: BootstrapState = {};
  const resources: BootstrapResource[] = [];
  const phases = {
    config: bootstrapConfig(options.phases.config),
    repositories: bootstrapRepositories(options.phases.repositories),
    kernel: bootstrapKernel(options.phases.kernel),
    extensions: bootstrapExtensions(options.phases.extensions),
    presentation: bootstrapPresentation(options.phases.presentation),
  };
  for (const name of ORDER) {
    const result = await phases[name](Object.freeze({ ...state }));
    if (!result.ok) {
      await createShutdown(resources)(`bootstrap:${name}:failed`);
      return err(gatewayError('BOOTSTRAP_PHASE_FAILED', `启动阶段失败：${name}`, 'bootstrap.phase_failed', {
        retryable: result.error.retryable,
        causeId: result.error.causeId,
        details: { phase: name, causeCode: result.error.code },
      }));
    }
    Object.assign(state, result.value.patch ?? {});
    resources.push(...(result.value.resources ?? []));
  }
  if (!state.services || !state.gateway || !state.capabilities) {
    await createShutdown(resources)('bootstrap:incomplete');
    return err(gatewayError('BOOTSTRAP_INCOMPLETE', '组合根缺少必要端口', 'bootstrap.incomplete'));
  }
  return ok({ services: state.services, gateway: state.gateway, capabilities: state.capabilities, shutdown: createShutdown(resources) });
}
