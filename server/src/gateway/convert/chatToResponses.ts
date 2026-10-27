/**
 * Chat Completions 响应 → Responses API 响应（非流式）。
 *
 * 为什么必须逐字段重建：Codex 解析的是 Responses 形状——顶层 `output` 数组，
 * 里面按 `type` 分派 `message`（读 `content[].text`）与 `function_call`
 * （读 `arguments`）。Chat 那边是 `choices[].message`，工具调用在 `tool_calls` 里。
 * 直接把 Chat 响应丢给 Codex 会被判为无法解析。
 *
 * 映射规则参考 new-api 的 `relaykit/relayconvert/internal/oai_chat/to_oai_responses_resp.go`。
 */

import { ConversionError } from './responsesToChat';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 生成 Responses 风格的 id。`msg_` / `fc_` / `rs_` / `ctc_` 这些前缀不是装饰：
 * Codex 侧按前缀区分 item 种类并用于日志/事件归属，前缀给错会让事件对不上。
 * id 只需要服务进程内唯一即可，所以直接用 responseId 拼下标，不引入随机数。
 */
function makeId(prefix: string, seed: string): string {
  return `${prefix}_${seed}`;
}

function convertUsage(usage: unknown): JsonObject {
  if (!isObject(usage)) {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }
  const input = Number(usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(usage.total_tokens ?? input + output),
    // prompt_tokens_details 是 Chat 侧的缓存命中明细；Responses 的叫
    // input_tokens_details，Codex 会读它展示"缓存省了多少 token"。
    // 上游没给就不写这个键，而不是塞一个空对象让界面显示成 0 命中。
    ...(usage.prompt_tokens_details === undefined
      ? {}
      : { input_tokens_details: usage.prompt_tokens_details }),
  };
}

/**
 * 把 Chat 的 `message` 展开成 Responses 的 `output` 数组。
 *
 * 顺序很重要：Codex 按 output 顺序重放历史，
 * 推理 → 正文 → 工具调用，与它自己生成时一致。
 */
function buildOutput(
  message: JsonObject,
  responseId: string,
  customToolNames: ReadonlySet<string>,
): unknown[] {
  const output: unknown[] = [];

  // 推理内容：Chat 上游通常放在 `reasoning_content`（非标准字段，
  // DeepSeek/vLLM 系常见），也有放在 `reasoning` 的。Responses 没有独立正文位，
  // 只能塞进 reasoning item 的 summary。字段缺失就不产出该项。
  const reasoning = asString(message.reasoning_content) || asString(message.reasoning);
  if (reasoning !== '') {
    output.push({
      type: 'reasoning',
      id: makeId('rs', responseId),
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }

  const content = message.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (isObject(part) ? asString(part.text) : ''))
            .join('')
        : '';

  // 只有确实有文本时才产出 message 项：空的 message 会让 Codex 显示一个空气泡
  if (text !== '') {
    output.push({
      type: 'message',
      id: makeId('msg', responseId),
      status: 'completed',
      role: 'assistant',
      // annotations 必须是数组：Codex 解析 output_text 时按数组处理，
      // 缺这个键会被当成格式不全。
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const [index, raw] of toolCalls.entries()) {
      if (!isObject(raw)) continue;
      const fn = isObject(raw.function) ? raw.function : {};
      const name = asString(fn.name);
      const rawArgs =
        typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});

      // 自定义工具（如 apply_patch）的调用必须还原成 `custom_tool_call`。
      // 若当成 function_call 交回 Codex，它下一轮会按 function_call 的历史去构造
      // 工具结果，发出的是 `function_call_output`；而工具定义是 custom 形态，
      // 两边对不上会导致调用链断掉。
      // 参数在请求方向被包成 `{"input": "..."}`（见 responsesToChat 的 custom 分支），
      // 这里解包回原始自由文本；上游没按约定返回时保留原串，宁可多一层 JSON 也不要丢内容。
      if (customToolNames.has(name)) {
        let input = rawArgs;
        try {
          const parsed: unknown = JSON.parse(rawArgs);
          if (isObject(parsed) && typeof parsed.input === 'string') input = parsed.input;
        } catch {
          // 上游没按约定返回，保留原始字符串
        }
        output.push({
          type: 'custom_tool_call',
          id: makeId('ctc', `${responseId}_${index}`),
          call_id: asString(raw.id),
          name,
          input,
          status: 'completed',
        });
        continue;
      }

      output.push({
        type: 'function_call',
        id: makeId('fc', `${responseId}_${index}`),
        // Chat 的工具调用 id 在这里必须保留：Codex 下一轮发的
        // function_call_output 用 call_id 与它配对，自己重编一个就配不上了。
        call_id: asString(raw.id),
        name,
        arguments: rawArgs,
        status: 'completed',
      });
    }
  }

  return output;
}

export interface ChatToResponsesOptions {
  model: string;
  /**
   * 本次请求里声明为 custom 的工具名。方向信息必须由调用方带进来：
   * 上游只回 `function`,从响应本身分不出它原本是 function 还是 custom。
   */
  customToolNames?: ReadonlySet<string>;
  /** 上游返回的原始响应 */
  chat: unknown;
  /** 用于生成 id 与 created_at */
  responseId?: string;
  createdAt?: number;
}

export function chatToResponsesResponse(options: ChatToResponsesOptions): JsonObject {
  const { chat, model } = options;
  if (!isObject(chat)) {
    throw new ConversionError('gateway.convert.responseNotObject');
  }

  const choices = chat.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    // 上游返回了没有 choices 的响应（常见于纯错误体但 200 的情况）。
    // 必须报错而不是造一个空 output：Codex 会把空结果当成"模型什么都没说"，
    // 真正的错误信息就彻底消失了。
    throw new ConversionError('gateway.convert.responseNoChoices');
  }
  // Chat 的 n>1 在这里没有意义：Codex 一次只要一条回复，多余候选无法表达。
  const choice = choices[0];
  if (!isObject(choice)) throw new ConversionError('gateway.convert.responseChoiceInvalid');

  const message = isObject(choice.message) ? choice.message : {};
  const responseId = options.responseId ?? asString(chat.id) ?? 'resp';
  const finishReason = asString(choice.finish_reason);

  return {
    id: makeId('resp', responseId),
    object: 'response',
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    // finish_reason=length 对应 Responses 的截断语义；Codex 见到 incomplete
    // 才会提示"输出被截断"，否则用户会以为模型说完了。
    status: finishReason === 'length' ? 'incomplete' : 'completed',
    model: asString(chat.model) || model,
    output: buildOutput(message, responseId, options.customToolNames ?? new Set()),
    usage: convertUsage(chat.usage),
    ...(finishReason === 'length'
      ? { incomplete_details: { reason: 'max_output_tokens' } }
      : {}),
    error: null,
  };
}
