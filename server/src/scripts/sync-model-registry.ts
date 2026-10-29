/**
 * 用两个公开数据源校准已保存供应商的模型能力。
 *
 * 数据源分工（已实测交叉验证）：
 * - **modelinfo.dev** `/v1/models`：`reasoning.efforts` 直接给数组，无需按 provider 投票，
 *   但不覆盖所有模型（我们 11 个里缺 2 个），且有大量 "supported 但 efforts 为空" 的条目。
 * - **models.dev** `models.json`：覆盖更全，用来补 modelinfo 的空缺。
 *
 * 为什么不自动跑：它会改写用户数据，偷偷改等于"配置自己变了"，出问题无法回溯；
 * 而且让 `apply` 依赖外网可达性也不可接受。
 *
 * 用法（在仓库根）：
 *   npm run registry:sync -w server                    # 演练：只打印会改什么
 *   npm run registry:sync -w server -- --write         # 落盘
 *   npm run registry:sync -w server -- --write --verify-efforts
 *                                                      # 额外实打上游校验每档档位
 *
 * `--verify-efforts` 会真实消耗额度：对每个模型声明的每个档位发一次极小的请求
 * （16 output tokens），只保留返回 2xx 的档位。用于挡掉"数据源声明了、上游却拒绝"
 * 的值（实测 claude-opus-5.5 的 `none` 在上游是 400）。
 *
 * 它只校验**数据源已经声明**的档位。数据源没有档位的模型（glm-5.3-flash /
 * kimi-k2.7-code 这类 `supported=true, efforts=[]`）在这里一个都验不到 ——
 * 那种情况要用网页上的「逐档实测」（`POST /api/providers/:id/probe-efforts`），
 * 它会把全部候选档位打一遍。两者共用 `services/effortProbe.ts` 的 `probeEffort()`，
 * 所以"档位是否被接受"的判定口径只有一份。
 */
import { translate } from '../i18n';
import { loadConfig } from '../config';
import { createLogger } from '../logger';
import { createContext } from '../context';
import { ProviderService, mergeCapabilities } from '../services/providers';
import { fetchModelRegistry, lookup as lookupRegistry } from '../services/modelRegistry';
import { fetchModelInfo, lookup as lookupInfo } from '../services/modelInfo';
import { API_TYPES, type ModelCapability, type ApiType } from '../domain/provider';
import { probeEffort } from '../services/effortProbe';

interface VerifyTarget {
  apiType: ApiType;
  baseUrl: string;
  apiKey: string;
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const verifyEfforts = process.argv.includes('--verify-efforts');

  const config = loadConfig();
  const ctx = createContext(config, createLogger('error'));
  const service = new ProviderService(ctx.store.forTenant('t_default'), ctx.secrets);

  // CLI 输出跟随 LOG_LANGUAGE（默认中文），与运行日志同一套设置
  const say = (key: string, params?: Record<string, string | number>): void => {
    console.log(translate(config.logLanguage, `logs.cli.${key}`, params));
  };
  say('dataDir', { dir: config.dataDir });
  say('mode', {
    mode: translate(
      config.logLanguage,
      write ? 'logs.cli.modeWrite' : 'logs.cli.modeDryRun',
    ),
  });
  if (verifyEfforts) say('verifyEfforts');
  console.log('');

  // 两个源独立失败：任一可用就继续，都不可用才退出
  const [info, registry] = await Promise.all([
    fetchModelInfo({ force: true }),
    fetchModelRegistry({ force: true }),
  ]);
  if (!info && !registry) {
    console.error(translate(config.logLanguage, 'logs.cli.sourcesUnavailable'));
    process.exitCode = 1;
    return;
  }
  const describe = (value: unknown): string =>
    value
      ? translate(config.logLanguage, 'logs.cli.countItems', {
          count: Object.keys(value as object).length,
        })
      : translate(config.logLanguage, 'logs.cli.unavailable');
  say('sourceStats', { info: describe(info), registry: describe(registry) });
  console.log('');

  let changedProviders = 0;
  let verifiedRequests = 0;

  for (const record of service.listRecords()) {
    if (!API_TYPES.includes(record.apiType)) continue;
    const current = record.modelCapabilities ?? {};
    const next: Record<string, ModelCapability> = {};
    const lines: string[] = [];
    let changed = 0;

    for (const model of record.models) {
      const before = current[model];
      let merged = mergeCapabilities(
        before,
        lookupRegistry(registry, model),
        lookupInfo(info, model),
      );

      // 逐档实测：只保留上游真正接受的档位。
      // 这是唯一能发现"数据源说支持、上游实际 400"的手段（如 claude 的 none）。
      if (verifyEfforts && merged?.reasoningEfforts?.length) {
        const target: VerifyTarget = {
          apiType: record.apiType,
          baseUrl: record.baseUrl,
          apiKey: service.plainApiKey(record),
        };
        const kept: string[] = [];
        const dropped: string[] = [];
        for (const effort of merged.reasoningEfforts) {
          verifiedRequests += 1;
          const accepted = await probeEffort(target, model, effort, config.logLanguage);
          if (accepted.accepted) kept.push(effort);
          else dropped.push(effort);
        }
        if (dropped.length > 0) {
          lines.push(
            translate(config.logLanguage, 'logs.cli.effortRejected', {
              model,
              levels: dropped.join(', '),
            }),
          );
        }
        merged = { ...merged, reasoningEfforts: kept };
        // 全被拒绝说明这个模型实际不支持 reasoning，别留一个空壳
        if (kept.length === 0) merged.supportsReasoning = false;
      }

      if (merged) next[model] = merged;

      const fmtEfforts = (values: string[] | undefined): string =>
        values === undefined
          ? translate(config.logLanguage, 'logs.cli.unknown')
          : values.length === 0
            ? translate(config.logLanguage, 'logs.cli.none')
            : values.join('/');
      const beforeEfforts = before?.reasoningEfforts;
      const afterEfforts = merged?.reasoningEfforts;
      const beforeCtx = before?.contextWindow;
      const afterCtx = merged?.contextWindow;
      if (
        beforeCtx !== afterCtx ||
        before?.maxOutputTokens !== merged?.maxOutputTokens ||
        fmtEfforts(beforeEfforts) !== fmtEfforts(afterEfforts)
      ) {
        changed += 1;
        const num = (v: number | undefined): string =>
          v === undefined ? '—' : v.toLocaleString('en-US');
        lines.push(
          `    ${model}: ctx ${num(beforeCtx)} → ${num(afterCtx)} | ` +
            translate(config.logLanguage, 'logs.cli.effortChanged', {
              before: fmtEfforts(beforeEfforts),
              after: fmtEfforts(afterEfforts),
            }),
        );
      }
    }

    if (changed === 0) {
      say('unchanged', { name: record.name, count: record.models.length });
      continue;
    }

    changedProviders += 1;
    say('changedCount', { name: record.name, changed, total: record.models.length });
    for (const line of lines) console.log(line);

    if (write) {
      service.update(record.id, {
        name: record.name,
        apiType: record.apiType,
        baseUrl: record.baseUrl,
        models: record.models,
        // 全量更新必须带上生图模型，否则同步一次能力表就把生图配置清空。
        // 服务层对未传有兜底，这里显式带上是为了让意图可读。
        imageModels: record.imageModels,
        modelCapabilities: next,
      });
    }
  }

  console.log('');
  if (verifyEfforts) {
    say('verifiedRequests', { count: verifiedRequests });
  }
  if (changedProviders === 0) {
    say('allUpToDate');
    return;
  }
  console.log(
    write
      ? translate(config.logLanguage, 'logs.cli.wroteProviders', { count: changedProviders })
      : translate(config.logLanguage, 'logs.cli.pendingProviders', { count: changedProviders }),
  );
}

void main();
