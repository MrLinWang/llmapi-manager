/**
 * Chat Completions 的 SSE 流 → Responses API 的 SSE 流。
 *
 * 为什么不能直通：Codex 解析的是 Responses 的**事件序列**，不是聊天补全增量。
 * 它靠 `response.created` 建响应、靠 `output_item.added` 建 item、靠
 * `output_item.done` 拿最终参数去执行工具。上游只会发
 * `data: {choices:[{delta:...}]}`，所以这里要把它逐事件翻译过去：
 *
 *   response.created
 *   → output_item.added        (message / function_call / reasoning)
 *   → output_text.delta        (正文增量)
 *   → function_call_arguments.delta  (工具参数增量)
 *   → output_item.done
 *   → response.completed / response.incomplete
 *
 * 事件类型与字段参考 new-api 的
 * `relaykit/relayconvert/internal/oai_chat/to_oai_responses_stream_resp.go`。
 *
 * 设计要点：
 * - 状态机逐行喂入，不缓冲整个响应——否则流式的意义就没了
 * - 上游什么时候发第一个 delta 是未知的，所以 `response.created` 与首个
 *   `output_item.added` 都是"第一次需要时才发"（懒发），避免空流也先发一堆事件
 * - 任何上游错误事件都要转成 `response.failed`，否则 Codex 会一直等下去：
 *   Responses 协议里没有"流悄悄结束"这种正常终止态
 */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export interface ResponsesStreamEvent {
  /** SSE 的 event: 字段 */
  event: string;
  /** JSON 载荷，会被序列化成 `data: ...` */
  data: JsonObject;
}

/** 上游一行 SSE 的解析结果 */
interface UpstreamChunk {
  /** `[DONE]` 或空行时为空 */
  payload: JsonObject | null;
}

/**
 * 解析一行 SSE 文本。返回 null 表示这行不是数据行（注释、event:、空行等）。
 */
function parseSseLine(line: string): UpstreamChunk | null {
  if (!line.startsWith('data:')) return null;
  const raw = line.slice(5).trim();
  if (raw === '') return null;
  if (raw === '[DONE]') return { payload: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    return { payload: isObject(parsed) ? parsed : null };
  } catch {
    // 不完整的 JSON（被截断的流）跳过而不是让整个流失败：
    // 丢掉一个坏 chunk 最多少一段增量，抛错则会让整轮对话白跑。
    return null;
  }
}

interface ToolCallState {
  /** Chat 的 tool_calls[].index，同一轮里标识"这是哪个工具调用" */
  index: number;
  /** 该调用在 Responses `output` 数组里的下标，事件里要用它定位 */
  outputIndex: number;
  id: string;
  name: string;
  /** 已累积的参数，用于最后补 .done 事件与还原 custom 的 input */
  args: string;
  added: boolean;
}

export class ChatStreamToResponsesConverter {
  private readonly model: string;
  private readonly responseId: string;
  private readonly createdAt: number;

  private sequence = 0;
  private sentCreated = false;
  private sentCompleted = false;

  /** 正文消息的 output 下标；null 表示还没有正文项 */
  private textOutputIndex: number | null = null;
  private text = '';
  private textAdded = false;
  private textDone = false;

  /** 推理项的 output 下标 */
  private reasoningOutputIndex: number | null = null;
  private reasoningText = '';
  private reasoningAdded = false;
  private reasoningDone = false;

  private readonly toolCalls = new Map<number, ToolCallState>();
  private nextOutputIndex = 0;

  private finishReason = '';
  private usage: JsonObject = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  private readonly customToolNames: ReadonlySet<string>;

  constructor(model: string, responseId?: string, customToolNames?: ReadonlySet<string>) {
    this.model = model;
    this.responseId = responseId ?? `resp_${Math.random().toString(36).slice(2, 12)}`;
    this.createdAt = Math.floor(Date.now() / 1000);
    this.customToolNames = customToolNames ?? new Set();
  }

  /** 该工具是否是 custom 类型：是则调用项要用 custom_tool_call 形状 */
  private isCustomTool(name: string): boolean {
    return this.customToolNames.has(name);
  }

  /**
   * 事件工厂：统一补 `type` 与单调递增的 `sequence_number`。
   * Codex 按 sequence_number 排序去重，乱序会让增量拼错，所以必须集中在
   * 一个地方自增，不能各处自己算。
   */
  private event(event: string, data: JsonObject): ResponsesStreamEvent {
    return { event, data: { type: event, sequence_number: this.sequence++, ...data } };
  }

  private nextIndex(): number {
    const index = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    return index;
  }

  private responseShell(status: string, output: unknown[]): JsonObject {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output,
      usage: this.usage,
      error: null,
    };
  }

  /**
   * 首次输出前必须发 `response.created`，Codex 靠它拿到 response id 并初始化视图。
   * 懒发：空流（上游什么都没说就结束）也发会多一个没人消费的事件。
   */
  private ensureCreated(): ResponsesStreamEvent[] {
    if (this.sentCreated) return [];
    this.sentCreated = true;
    return [this.event('response.created', { response: this.responseShell('in_progress', []) })];
  }

  /**
   * 收尾：把未关闭的项补上 done，再发 completed / incomplete。
   *
   * 为什么要在这里补 done：Codex 是在 `output_item.done` 时才拿到**完整**参数并
   * 真正执行工具的。上游可能不发最后一个参数 chunk 就直接 [DONE]，不补的话
   * 工具永远不会被执行——表现为"模型说了要调用工具，但什么都没发生"。
   */
  private finalize(): ResponsesStreamEvent[] {
    if (this.sentCompleted) return [];
    this.sentCompleted = true;

    const events: ResponsesStreamEvent[] = [];

    // 正文项没关闭过就补 done
    if (this.textAdded && !this.textDone && this.textOutputIndex !== null) {
      this.textDone = true;
      events.push(
        this.event('response.output_text.done', {
          item_id: `msg_${this.responseId}`,
          output_index: this.textOutputIndex,
          content_index: 0,
          text: this.text,
        }),
      );
      events.push(
        this.event('response.output_item.done', {
          output_index: this.textOutputIndex,
          item: {
            type: 'message',
            id: `msg_${this.responseId}`,
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: this.text, annotations: [] }],
          },
        }),
      );
    }

    if (this.reasoningAdded && !this.reasoningDone && this.reasoningOutputIndex !== null) {
      this.reasoningDone = true;
      // 与正文对称：先收尾 summary_text，再收尾 output_item。
      // Codex 真正依赖的是 output_item.done（它从中解析出 reasoning item）；
      // summary_text.done 目前落在它的忽略列表里，但官方流同样是这么发的，
      // 保留是为了让事件序列与官方一致，换客户端也不会缺项。
      events.push(
        this.event('response.reasoning_summary_text.done', {
          item_id: `rs_${this.responseId}`,
          output_index: this.reasoningOutputIndex,
          summary_index: 0,
          text: this.reasoningText,
        }),
      );
      events.push(
        this.event('response.reasoning_summary_part.done', {
          item_id: `rs_${this.responseId}`,
          output_index: this.reasoningOutputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: this.reasoningText },
        }),
      );
      events.push(
        this.event('response.output_item.done', {
          output_index: this.reasoningOutputIndex,
          item: {
            type: 'reasoning',
            id: `rs_${this.responseId}`,
            summary: [{ type: 'summary_text', text: this.reasoningText }],
          },
        }),
      );
    }

    // 工具调用的 done：必须带**完整**参数。Codex 只在 output_item.done 里取
    // arguments/input 去执行命令，缺这次事件 = 工具永远不执行。
    for (const call of this.toolCalls.values()) {
      const custom = this.isCustomTool(call.name);
      // custom 工具（如 apply_patch）的参数在请求方向被包成 {"input": "..."}，
      // 这里解包回自由文本。不还原的话 Codex 会把整段 JSON 当成 patch 文本。
      let customInput = call.args;
      if (custom) {
        try {
          const parsed: unknown = JSON.parse(call.args);
          if (isObject(parsed) && typeof parsed.input === 'string') customInput = parsed.input;
        } catch {
          // 上游没按约定返回，保留原始字符串
        }
      } else {
        events.push(
          this.event('response.function_call_arguments.done', {
            item_id: `fc_${this.responseId}_${call.index}`,
            output_index: call.outputIndex,
            arguments: call.args,
          }),
        );
      }
      events.push(
        this.event('response.output_item.done', {
          output_index: call.outputIndex,
          item: custom
            ? {
                type: 'custom_tool_call',
                id: `ctc_${this.responseId}_${call.index}`,
                // 与 output_item.added 用同一兜底：上游若始终没发 id，
                // 两处 call_id 不一致会让 Codex 关联失败，下一轮回传的输出对不上。
                call_id: call.id || `call_${this.responseId}_${call.index}`,
                name: call.name,
                input: customInput,
                status: 'completed',
              }
            : {
                type: 'function_call',
                id: `fc_${this.responseId}_${call.index}`,
                call_id: call.id || `call_${this.responseId}_${call.index}`,
                name: call.name,
                arguments: call.args,
                status: 'completed',
              },
        }),
      );
    }

    // finish_reason=length 用 response.incomplete 而不是 completed：
    // Codex 见到 incomplete 才会提示"输出被截断"，否则用户会以为模型正常说完。
    // incomplete_details.reason 必须是 Codex 认识的字符串，这里映射成官方取值
    // max_output_tokens（上游的 "length" 不是 Responses 的合法 reason）。
    const incomplete = this.finishReason === 'length';
    const status = incomplete ? 'incomplete' : 'completed';
    events.push(
      this.event(incomplete ? 'response.incomplete' : 'response.completed', {
        response: {
          ...this.responseShell(status, []),
          ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        },
      }),
    );
    return events;
  }

  /**
   * 正文增量：首次到达时才补 `output_item.added` 与 `content_part.added`。
   * Codex 当前只消费 output_text.delta（content_part 系列在它的忽略列表里），
   * 但官方 Responses 流会成对发 added/part 事件，补齐可让其他客户端也能正常工作。
   */
  private appendTextDelta(delta: string): ResponsesStreamEvent[] {
    if (delta === '') return [];
    const events = this.ensureCreated();

    if (!this.textAdded) {
      this.textAdded = true;
      this.textOutputIndex = this.nextIndex();
      events.push(
        this.event('response.output_item.added', {
          output_index: this.textOutputIndex,
          item: {
            type: 'message',
            id: `msg_${this.responseId}`,
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
        }),
      );
      events.push(
        this.event('response.content_part.added', {
          item_id: `msg_${this.responseId}`,
          output_index: this.textOutputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }),
      );
    }

    this.text += delta;
    events.push(
      this.event('response.output_text.delta', {
        item_id: `msg_${this.responseId}`,
        output_index: this.textOutputIndex,
        content_index: 0,
        delta,
      }),
    );
    return events;
  }

  /**
   * 推理摘要增量。Chat 上游把思维链放在非标准的 reasoning_content 里，
   * Responses 侧对应 reasoning item 的 summary_text——所以这里发的是
   * `reasoning_summary_text.*` 而不是 `reasoning_text.*`。
   */
  private appendReasoningDelta(delta: string): ResponsesStreamEvent[] {
    if (delta === '') return [];
    const events = this.ensureCreated();

    if (!this.reasoningAdded) {
      this.reasoningAdded = true;
      this.reasoningOutputIndex = this.nextIndex();
      events.push(
        this.event('response.output_item.added', {
          output_index: this.reasoningOutputIndex,
          item: {
            type: 'reasoning',
            id: `rs_${this.responseId}`,
            summary: [],
          },
        }),
      );
      events.push(
        this.event('response.reasoning_summary_part.added', {
          item_id: `rs_${this.responseId}`,
          output_index: this.reasoningOutputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        }),
      );
    }

    this.reasoningText += delta;
    events.push(
      this.event('response.reasoning_summary_text.delta', {
        item_id: `rs_${this.responseId}`,
        output_index: this.reasoningOutputIndex,
        summary_index: 0,
        delta,
      }),
    );
    return events;
  }

  /**
   * 工具调用增量。Chat 把同一个调用的 id/name/arguments 拆成多个 chunk 发送，
   * 且用 `index` 区分同一轮里的多个调用，所以必须按 index 累积状态、
   * 不能假设"一个 chunk 就是一个完整调用"。
   */
  private appendToolCallDelta(raw: JsonObject): ResponsesStreamEvent[] {
    const events = this.ensureCreated();
    const index = Number(raw.index ?? 0);
    let call = this.toolCalls.get(index);

    if (!call) {
      call = {
        index,
        outputIndex: this.nextIndex(),
        id: asString(raw.id),
        name: '',
        args: '',
        added: false,
      };
      this.toolCalls.set(index, call);
    }
    // id / name 可能分散在多个 chunk 里，逐次补齐
    if (asString(raw.id) !== '') call.id = asString(raw.id);
    const fn = isObject(raw.function) ? raw.function : {};
    if (asString(fn.name) !== '') call.name = asString(fn.name);

    // 参数可能先于 name 到达（有的聚合上游把 name 分段拼在后面的 chunk 里）。
    // 所以先无条件累积，added 时再把已累积的那部分补发出去——否则首个 chunk 的
    // 参数会被静默丢弃，Codex 拿到残缺 JSON 执行命令，且没有任何日志。
    const pendingArgs = asString(fn.arguments);
    if (pendingArgs !== '') call.args += pendingArgs;

    if (!call.added && call.name !== '') {
      call.added = true;
      const custom = this.isCustomTool(call.name);
      events.push(
        this.event('response.output_item.added', {
          output_index: call.outputIndex,
          item: {
            // custom 工具必须用 custom_tool_call 形状声明。若这里报成
            // function_call，Codex 会按 function 语义构造后续历史，
            // 与工具定义（custom）不一致，调用链会断。
            type: custom ? 'custom_tool_call' : 'function_call',
            id: `${custom ? 'ctc' : 'fc'}_${this.responseId}_${call.index}`,
            // id 可能还没到（有的上游把它放在后续 chunk）。先占位保证 shape 完整；
            // Codex 只把它当回传标识，后续 chunk 到了会用真实 id 覆盖。
            call_id: call.id || `call_${this.responseId}_${call.index}`,
            name: call.name,
            ...(custom ? { input: '' } : { arguments: '' }),
            status: 'in_progress',
          },
        }),
      );
    }

    // added 之前累积的那些参数，现在补发（added 之后到达的在下面正常发）
    const argsDelta = pendingArgs;
    if (argsDelta !== '' && call.added) {
      // custom 工具这里刻意不发增量事件。注意 Responses 是有
      // `response.custom_tool_call_input.delta` 的（Codex 也解析它），
      // 不能转发的原因在编码上：上游给的增量是 JSON 参数 `{"input":"…"}` 的片段，
      // 直接当 input 文本发出去会带上 JSON 引号与转义，Codex 拿到的就是错的补丁内容。
      // 要做对必须在这里维护一个增量 JSON 字符串解码器，成本与收益不成比例；
      // 所以完整 input 统一在 output_item.done 一次性给出（见 finalize）。
      // 表现上只是"参数不流式显示"，apply_patch 仍能正常执行。
      if (!this.isCustomTool(call.name)) {
        events.push(
          this.event('response.function_call_arguments.delta', {
            item_id: `fc_${this.responseId}_${call.index}`,
            output_index: call.outputIndex,
            delta: argsDelta,
          }),
        );
      }
    }
    return events;
  }

  /**
   * 喂入上游的一行。返回需要写给客户端的事件（可能为空）。
   *
   * `[DONE]` 与"上游连接断了"都必须经由 `finish()` 收尾：Codex 侧只有收到
   * completed/incomplete/failed 才算这一轮结束，少发就等于让它一直挂着等。
   */
  feedLine(line: string): ResponsesStreamEvent[] {
    const chunk = parseSseLine(line);
    if (chunk === null) return [];
    if (chunk.payload === null) {
      // [DONE]
      return this.finish();
    }
    return this.feedChunk(chunk.payload);
  }

  private feedChunk(payload: JsonObject): ResponsesStreamEvent[] {
    // 流已终止（completed/failed/incomplete 任一已发）后不再产出任何事件。
    // 正常调用链不会喂到这里，但 converter 自己的契约要成立：复用时
    // （例如调用方漏了 [DONE] 处理）不能发出协议非法的事件序列。
    if (this.sentCompleted) return [];
    // 上游错误：Codex 把 response.failed 解析成 Api 错误并终止本轮。
    // 缺这步的表现是客户端一直转圈等下去，直到自己超时——比报错难排查得多。
    const error = payload.error;
    if (isObject(error)) {
      // 标记流已终止：`forward.ts` 在读到 EOF 后总会调 finish()，
      // 若不标记，这里发完 response.failed 之后还会补 output_item.done
      // 与 response.completed —— 同一轮既失败又成功，属于协议违规，
      // Codex 侧会记录自相矛盾的状态。用 sentCompleted 复用同一个"已结束"标志。
      this.sentCompleted = true;
      return [
        ...this.ensureCreated(),
        this.event('response.failed', {
          response: {
            ...this.responseShell('failed', []),
            error: {
              code: asString(error.code) || 'upstream_error',
              message: asString(error.message) || '上游返回错误',
            },
          },
        }),
      ];
    }

    // usage 通常在最后一个 chunk（开了 stream_options.include_usage）；
    // 也可能在任意 chunk 出现，所以每次都更新而不是只在结尾读。
    if (isObject(payload.usage)) this.usage = this.convertUsage(payload.usage);

    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) return [];

    const events: ResponsesStreamEvent[] = [];
    // 只取 choices[0]：Codex 一次只要一条回复，n>1 的候选无法在 Responses 里表达。
    const choice = choices[0];
    if (!isObject(choice)) return [];

    const delta = isObject(choice.delta) ? choice.delta : {};

    // 推理增量先于正文：Codex 侧会把 summary 渲染在正文上方的折叠区，
    // 顺序反了会让它把摘要当成正文的一部分。
    const reasoning = asString(delta.reasoning_content) || asString(delta.reasoning);
    if (reasoning !== '') events.push(...this.appendReasoningDelta(reasoning));

    const content = delta.content;
    if (typeof content === 'string' && content !== '') {
      events.push(...this.appendTextDelta(content));
    }

    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const raw of toolCalls) {
        if (isObject(raw)) events.push(...this.appendToolCallDelta(raw));
      }
    }

    const finish = asString(choice.finish_reason);
    if (finish !== '') this.finishReason = finish;

    return events;
  }

  private convertUsage(usage: JsonObject): JsonObject {
    const input = Number(usage.prompt_tokens ?? 0);
    const output = Number(usage.completion_tokens ?? 0);
    return {
      input_tokens: input,
      output_tokens: output,
      total_tokens: Number(usage.total_tokens ?? input + output),
    };
  }

  /** 流结束。重复调用安全（幂等）：finish 与 [DONE] 都可能触发。 */
  finish(): ResponsesStreamEvent[] {
    if (this.sentCompleted) return [];
    return [...this.ensureCreated(), ...this.finalize()];
  }
}

/** 把事件序列化成 SSE 文本 */
export function serializeResponsesEvent(event: ResponsesStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
