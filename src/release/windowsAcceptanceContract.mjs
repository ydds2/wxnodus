// src/release/windowsAcceptanceContract.mjs — 受控 Windows runner 与 Gate E 双 OS-keyed 不可变 receipt：
// Win11-24h2 是 production-real 单元；Win10-22h2 只是 legacy-compatibility receipt；物理前置缺失一律 blocked
// （纯 ESM 实现：node 脚本可直接消费；类型声明见 windowsAcceptanceContract.d.mts）

const receiptKeyMatchesRunner = (receipt) =>
  receipt.receiptKey === 'windows-11-24h2-production-real'
    ? receipt.runner.os.family === 'win11' && receipt.runner.labels.includes('win11-24h2')
    : receipt.runner.os.family === 'win10' && receipt.runner.labels.includes('win10-22h2');

export function aggregateGateEReceipts(receipts) {
  const required = [
    'windows-11-24h2-production-real',
    'windows-10-22h2-legacy-compatibility',
  ];
  const byKey = new Map(receipts.map(receipt => [receipt.receiptKey, receipt]));
  const missing = required.filter(key => !byKey.has(key));
  if (missing.length > 0 || byKey.size !== receipts.length) {
    return { status: 'blocked', code: 'WINDOWS_REQUIRED_RECEIPT_MISSING', missing };
  }
  const values = required.map(key => byKey.get(key));
  if (values.some(receipt => receipt.closure.status !== 'closed' || !/^[a-f0-9]{64}$/.test(receipt.manifestSha256))) {
    return { status: 'blocked', code: 'WINDOWS_RECEIPT_NOT_CLOSED' };
  }
  if (values.some(receipt => !receiptKeyMatchesRunner(receipt) || evaluateWindowsRunner(receipt.runner).status !== 'passed')) {
    return { status: 'blocked', code: 'WINDOWS_RECEIPT_KEY_MISMATCH' };
  }
  const [first, ...rest] = values;
  if (rest.some(receipt => receipt.runId !== first.runId || receipt.candidateCommit !== first.candidateCommit ||
      receipt.artifact.id !== first.artifact.id || receipt.artifact.sha256 !== first.artifact.sha256)) {
    return { status: 'blocked', code: 'WINDOWS_RECEIPT_CANDIDATE_MISMATCH' };
  }
  if (values.some(receipt => !receipt.fixtures.sourceHashesValid || !receipt.fixtures.artifactHashesValid ||
      receipt.scenarios.some(scenario => scenario.status !== 'passed' || scenario.attachmentIds.length === 0))) {
    return { status: 'blocked', code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED' };
  }
  return { status: 'passed', receiptIds: values.map(receipt => receipt.receiptId) };
}

export function evaluateWindowsRunner(snapshot) {
  const missing = [];
  if (!snapshot.selfHosted || !snapshot.labels.includes('self-hosted') || !snapshot.labels.includes('windows') ||
      !snapshot.labels.includes('x64') || !snapshot.labels.includes('interactive')) missing.push('WINDOWS_RUNNER_NOT_SELF_HOSTED');
  const osLabels = snapshot.labels.filter(label => label === 'win10-22h2' || label === 'win11-24h2');
  if (osLabels.length !== 1) missing.push('WINDOWS_OS_BASELINE_UNSUPPORTED');
  if (!snapshot.interactive || !snapshot.unlocked || snapshot.sessionId <= 0 || snapshot.inputDesktop !== 'Default') missing.push('WINDOWS_INTERACTIVE_SESSION_REQUIRED');
  if (!snapshot.node.version.startsWith('22.') || snapshot.node.arch !== 'x64' ||
      !/^[a-f0-9]{64}$/.test(snapshot.artifact.sha256) ||
      !/^[a-f0-9]{64}$/.test(snapshot.environment.sha256) ||
      !/^[a-f0-9]{64}$/.test(snapshot.capability.sha256)) missing.push('WINDOWS_RUNNER_NOT_SELF_HOSTED');
  const build = Number(snapshot.os.version.split('.')[2]);
  const baseline = snapshot.os.family === 'win10'
    ? build === 19045 && osLabels[0] === 'win10-22h2'
    : build === 26100 && osLabels[0] === 'win11-24h2';
  if (!baseline) missing.push('WINDOWS_OS_BASELINE_UNSUPPORTED');
  if (!snapshot.microphones.some(device => device.active && device.physical)) missing.push('WINDOWS_MICROPHONE_REQUIRED');
  if (snapshot.sapiVoices.length === 0 || !snapshot.sapiPlaybackPassed) missing.push('WINDOWS_SAPI_REQUIRED');
  if (!snapshot.fixtures.sourceHashesValid || !snapshot.fixtures.artifactHashesValid || !/^[a-f0-9]{64}$/.test(snapshot.fixtures.lockSha256)) missing.push('WINDOWS_FIXTURE_LOCK_INVALID');
  const physicalMonitors = snapshot.monitors.filter(monitor => monitor.physical);
  if (physicalMonitors.length < 2) missing.push('WINDOWS_MULTIMONITOR_REQUIRED');
  if (physicalMonitors.length === 0 || Math.min(...physicalMonitors.map(monitor => monitor.x)) >= 0) missing.push('WINDOWS_NEGATIVE_ORIGIN_REQUIRED');
  if (new Set(physicalMonitors.map(monitor => monitor.scale)).size < 2) missing.push('WINDOWS_MIXED_DPI_REQUIRED');
  return missing.length === 0 ? { status: 'passed' } : {
    status: 'blocked', code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED', missing,
  };
}
