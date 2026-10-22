/**
 * 启动期告警（文件损坏、缺加密密钥、密钥自动生成等）。
 * 收集后由 /api/health 暴露，避免"启动日志刷过去了用户没看见"。
 */
export interface StartupWarning {
  code: string;
  message: string;
}

const warnings: StartupWarning[] = [];

export function addWarning(code: string, message: string): void {
  if (warnings.some((item) => item.code === code)) return;
  warnings.push({ code, message });
}

export function getWarnings(): StartupWarning[] {
  return [...warnings];
}

export function resetWarnings(): void {
  warnings.length = 0;
}
