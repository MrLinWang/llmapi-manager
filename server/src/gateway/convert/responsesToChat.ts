/**
 * Responses API 请求 → Chat Completions 请求。
 *
 * 存在意义：Codex CLI 只会发 `/v1/responses`，而大量上游只实现了 Chat Completions。
 * 网关在此把请求体改写成 Chat 形状，同时 forward.ts 会把上游路径也换成
 * `/chat/completions`（见 upstreamPathFor）——两者必须同时成立，只改 body 会 404。
 *
 * 映射规则参考 new-api 的 `relaykit/relayconvert/internal/oai_responses/to_oai_chat_req.go`
 * （本仓库是独立实现，没有复制其代码）。主干映射：
 *
 * - `instructions` → 首条 `system` 消息
 * - `input` 字符串 → `user` 消息；数组则逐项映射
 * - `input` 里的 `function_call` → 最近一条 assistant 的 `tool_calls`
 * - `input` 里的 `function_call_output` → `tool` 消息（`tool_call_id` 对应）
 * - `tools` 由扁平 `{type,name,description,parameters}` 改成嵌套 `{type,function:{...}}`
 * - `max_output_tokens` → `max_tokens`
 *
 * 有损转换分两档处理，区别在于"丢了会不会让用户误以为某功能生效了"：
 * - 有状态特性（conversation / previous_response_id）**直接报错**：用户以为续上了
 *   会话、实际没有，这种错误无法从结果上察觉。
 * - 纯展示/无等价物的字段（metadata、store、托管工具等）**丢弃并记入 meta.dropped**，
 *   交给日志与响应头，否则绝大多数正常请求都会失败。
 */

export interface ConversionMeta {
  /**
   * 因转换而丢弃的字段名。不是调试残留：forward.ts 会把它写进日志与响应头，
   * 用来回答"为什么上游没按预期工作"（如托管工具被丢、模型没联网）。
   */
  dropped: string[];
}

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionError';
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Responses 的 `input` 项可能是纯文本消息，也可能是函数调用。 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/**
 * Responses 的 `content` 是内容块数组，Chat 的 user 消息在有图片时必须也用数组。
 *
 * 映射：
 * - `{type:"input_text", text}` / `{type:"output_text"}` → `{type:"text", text}`
 * - `{type:"input_image", image_url}` → `{type:"image_url", image_url:{url}}`
 *
 * 纯文本时降级回字符串，而不是给上游一个单元素数组：部分老上游只认字符串 content。
 */
function convertContentParts(content: unknown, meta: ConversionMeta): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content ?? '';

  const parts: unknown[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (!isObject(part)) continue;
    const type = asString(part.type);

    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      parts.push({ type: 'text', text: asString(part.text) });
      continue;
    }

    if (type === 'input_image') {
      // Responses 把 url 直接放在块上；Chat 要求包一层 `{image_url:{url}}`。
      // detail 原样带上（auto/low/high/original），Chat 上游认识这几个值。
      const raw = part.image_url;
      const url = typeof raw === 'string' ? raw : asString((raw as JsonObject | undefined)?.url);
      if (url === '') {
        // Codex 的 ImageReference 是 untagged 的 `{image_url}` | `{file_id}` 二选一。
        // file_id 是 OpenAI 服务端的文件引用，只有能访问同一份文件存储的上游才解析得了；
        // Chat 的 image_url 只收 URL，没有等价物。保留会造成"图被静默忽略"，
        // 所以丢弃并记录，让用户能看出是转换丢的。
        meta.dropped.push('input_image.file_id');
        continue;
      }
      const detail = typeof raw === 'object' && raw !== null ? (raw as JsonObject).detail : part.detail;
      parts.push({
        type: 'image_url',
        image_url: detail === undefined ? { url } : { url, detail },
      });
      continue;
    }

    // input_file / input_audio 在 Chat 里没有通用形态（音频需专用端点、文件需先上传）。
    // 丢进 dropped 而不是报错：这类块常出现在多模态历史里，报错会让整轮对话不可用。
    meta.dropped.push(`content.${type || 'unknown'}`);
  }

  // 全是文本时降级成字符串：某些老上游只接受字符串内容
  const allText = parts.every(
    (part) => isObject(part) && part.type === 'text',
  );
  if (allText) {
    return parts.map((part) => asString((part as JsonObject).text)).join('');
  }
  return parts;
}

/**
 * 把 Responses 的 `input` 项转成 Chat 消息，追加到 `messages`。
 *
 * 关键约束：Chat 要求"一段 assistant.tool_calls 后面紧跟它对应的所有 tool 消息"。
 * Responses 的 input 是扁平列表，而 Codex 本来就是把 assistant 的调用和
 * tool 结果按序追加进去的，所以照原序追加即可满足该约束，不需要重排。
 */
function appendInputItem(
  item: unknown,
  messages: ChatMessage[],
  meta: ConversionMeta,
): void {
  // 纯字符串项等价于一条 user 消息
  if (typeof item === 'string') {
    messages.push({ role: 'user', content: item });
    return;
  }
  if (!isObject(item)) {
    throw new ConversionError('input 数组里的元素必须是对象或字符串');
  }

  const type = asString(item.type);

  switch (type) {
    case 'function_call': {
      // 模型上一轮发起的工具调用，需要挂到最近一条 assistant 上
      const callId = asString(item.call_id) || asString(item.id);
      const name = asString(item.name);
      if (!callId || !name) {
        throw new ConversionError('function_call 缺少 call_id 或 name');
      }
      const toolCall = {
        id: callId,
        type: 'function',
        function: {
          name,
          // Responses 的 arguments 是 JSON 字符串，与 Chat 一致
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      };
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        last.tool_calls = [...(last.tool_calls ?? []), toolCall];
      } else {
        // 没有可挂载的 assistant（例如历史被截断），补一条空的
        messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
      }
      return;
    }

    case 'custom_tool_call': {
      // 自定义工具（如 apply_patch）：入参是自由文本，没有 JSON schema。
      // Chat 只有 function 一种工具类型，所以把原始文本包进 {"input": "..."}，
      // 让"工具定义"与"调用参数"两个方向共用同一个约定：
      // 定义侧声明只有一个字符串参数 input（见 convertTools），调用侧就照此编码。
      // 两边必须同时改——只改一边会让模型看到参数对不上的工具。
      const callId = asString(item.call_id) || asString(item.id);
      const name = asString(item.name);
      if (!callId || !name) {
        throw new ConversionError('custom_tool_call 缺少 call_id 或 name');
      }
      const raw = item.input;
      const input = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      const toolCall = {
        id: callId,
        type: 'function',
        function: { name, arguments: JSON.stringify({ input }) },
      };
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        last.tool_calls = [...(last.tool_calls ?? []), toolCall];
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
      }
      return;
    }

    case 'custom_tool_call_output': {
      // 与 function_call_output 同形：call_id 把结果对回上面那条 function 调用。
      // 注意这里**不需要**拆 {"input"} 包——工具返回值本来就是自由文本，原样作为
      // tool 消息内容即可；只有响应方向（还原模型发起的调用）才需要解包。
      const callId = asString(item.call_id);
      if (!callId) throw new ConversionError('custom_tool_call_output 缺少 call_id');
      const output = item.output;
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
      });
      return;
    }

    case 'function_call_output': {
      const callId = asString(item.call_id);
      if (!callId) throw new ConversionError('function_call_output 缺少 call_id');
      const output = item.output;
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        // Chat 的 tool 消息只接受字符串；结构化输出序列化成 JSON 字符串透传，
        // 信息不丢，只是模型看到的是文本而非对象。
        content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
      });
      return;
    }

    case 'message':
    case '': {
      // `message` 是最常见形态；空 type 也按消息处理（部分客户端会省略）
      const role = asString(item.role) || 'user';
      if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') {
        throw new ConversionError(`input 消息的 role 不支持: ${role}`);
      }
      // developer 是 Responses 里的新角色（Codex 用它下发环境/权限说明），
      // Chat 没有这个概念；降级为 system 让模型仍能看到这些约束，
      // 比直接丢弃安全——丢了模型就不知道自己的工作目录与权限边界。
      const mappedRole = role === 'developer' ? 'system' : role;
      messages.push({ role: mappedRole, content: convertContentParts(item.content, meta) });
      return;
    }

    case 'reasoning': {
      // 推理项是模型上一轮的思维链。Chat 上游不接受 reasoning 作为**输入**，
      // 它只影响展示、不参与后续格式，丢掉不会改变模型能看到的对话内容。
      meta.dropped.push('input.reasoning');
      return;
    }

    default:
      // 未知类型不猜，明确报错。静默跳过会让上游收到的上下文比用户以为的少。
      throw new ConversionError(`不支持的 input 项类型: ${type}`);
  }
}

/** Responses 的工具是扁平的，Chat 要嵌在 `function` 下面。 */
function convertTools(tools: unknown, meta: ConversionMeta): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const out: unknown[] = [];
  for (const tool of tools) {
    if (!isObject(tool)) {
      throw new ConversionError('tools 里的元素必须是对象');
    }
    const type = asString(tool.type);

    // 自定义工具（自由文本入参，无 JSON schema）。Chat 只有 function，
    // 所以声明成"只有一个字符串参数 input"的 function。
    // 必须与 custom_tool_call 的编码形状严格对齐（{input: "..."}），
    // 否则模型看到的参数说明与实际回传的调用形状不一致，会乱编参数名。
    if (type === 'custom') {
      out.push({
        type: 'function',
        function: {
          name: asString(tool.name),
          description: asString(tool.description) || undefined,
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: asString(tool.description) || '工具的原始文本输入',
              },
            },
            required: ['input'],
          },
        },
      });
      continue;
    }

    if (type !== 'function') {
      // web_search / file_search / computer_use 这类**托管工具**由 OpenAI 服务端执行，
      // Chat 协议没有对应字段。丢弃并记录：不记录的话用户只会看到"模型没联网"，
      // 却查不出是转换丢的（这也是文档建议同时关掉 web_search 的原因）。
      meta.dropped.push(`tools.${type || 'unknown'}`);
      continue;
    }
    out.push({
      type: 'function',
      function: {
        name: asString(tool.name),
        description: asString(tool.description) || undefined,
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

/** `tool_choice` 在两种协议里形状接近，但 Responses 允许直接给字符串。 */
function convertToolChoice(choice: unknown, meta: ConversionMeta): unknown {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === 'string') return choice;
  if (isObject(choice)) {
    const type = asString(choice.type);
    // `{type:"function",name:"x"}` → `{type:"function",function:{name:"x"}}`
    if (type === 'function' && typeof choice.name === 'string') {
      return { type: 'function', function: { name: choice.name } };
    }
    if (type === 'auto' || type === 'none' || type === 'required') return type;
  }
  meta.dropped.push('tool_choice');
  return undefined;
}

/** `text.format` → `response_format`（两边字段名不同，形状基本同构）。 */
function convertResponseFormat(text: unknown, meta: ConversionMeta): unknown {
  if (!isObject(text)) return undefined;
  const format = text.format;
  if (!isObject(format)) return undefined;

  const type = asString(format.type);
  if (type === 'json_schema') {
    // name 是必填项且参与上游缓存键；调用方没给时用固定占位名，避免不同 schema
    // 因为同名而共用缓存。
    return {
      type: 'json_schema',
      json_schema: {
        name: asString(format.name) || 'response',
        schema: format.schema ?? {},
        ...(format.strict === undefined ? {} : { strict: format.strict }),
      },
    };
  }
  if (type === 'json_object') return { type: 'json_object' };
  // 纯文本是 Chat 的默认行为，不需要 response_format
  if (type === 'text') return undefined;
  meta.dropped.push(`text.format.${type || 'unknown'}`);
  return undefined;
}

/**
 * Responses 明确支持、但 Chat 没有等价物的**有状态**特性。
 * 这些不能静默丢弃：用户以为用了会话状态，实际没有，行为会莫名其妙。
 */
const UNSUPPORTED_FIELDS = ['conversation', 'previous_response_id'] as const;

export function responsesToChatRequest(
  body: unknown,
  model: string,
): { body: JsonObject; meta: ConversionMeta } {
  if (!isObject(body)) {
    throw new ConversionError('请求体必须是 JSON 对象');
  }
  const meta: ConversionMeta = { dropped: [] };

  for (const field of UNSUPPORTED_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) {
      throw new ConversionError(
        `字段 ${field} 依赖服务端会话状态，Chat 上游无法支持；请关闭该特性或改用 Responses 上游`,
      );
    }
  }

  const messages: ChatMessage[] = [];

  // instructions 相当于 system 提示，必须排在最前面
  const instructions = asString(body.instructions);
  if (instructions.trim() !== '') {
    messages.push({ role: 'system', content: instructions });
  }

  const input = body.input;
  if (typeof input === 'string') {
    if (input !== '') messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) appendInputItem(item, messages, meta);
  } else if (input !== undefined && input !== null) {
    throw new ConversionError('input 必须是字符串或数组');
  }

  if (messages.length === 0) {
    throw new ConversionError('转换后没有任何消息，请检查 input 与 instructions');
  }

  const out: JsonObject = { model, messages, stream: body.stream === true };

  const tools = convertTools(body.tools, meta);
  if (tools) out.tools = tools;

  const toolChoice = convertToolChoice(body.tool_choice, meta);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  const responseFormat = convertResponseFormat(body.text, meta);
  if (responseFormat !== undefined) out.response_format = responseFormat;

  // reasoning.effort → reasoning_effort：两边取值域重叠（none/minimal/low/medium/
  // high/xhigh），直接透传。
  if (isObject(body.reasoning)) {
    const effort = asString(body.reasoning.effort);
    if (effort !== '') {
      // 不做白名单校验：Codex 的 ReasoningEffort 还有 max/ultra/persistent 等新增值，
      // 我们这边没有版本信息判断上游认不认。原样透传，让上游自己报错——
      // 比在这里静默丢弃更容易发现版本不匹配，也不会凭空降级推理强度。
      out.reasoning_effort = effort;
    }
    // reasoning.summary 是"要不要把思考摘要回传给我"。这是 Responses 的**协议级开关**，
    // 而 Chat 里有没有 reasoning_content 完全由上游自己决定，没有请求侧参数可表达。
    // 丢弃它不会丢对话内容，只会让 Codex 的思考折叠区可能没东西可显示；
    // 记进 dropped 是为了让"摘要没出来"能被归因到转换，而不是去怀疑模型。
    if (body.reasoning.summary !== undefined) meta.dropped.push('reasoning.summary');
  }

  // 采样参数：两边同名同义
  for (const field of ['temperature', 'top_p', 'user']) {
    if (body[field] !== undefined) out[field] = body[field];
  }
  if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;

  // Chat 侧的流式用量统计默认不返回，必须显式要；没有它，响应的
  // response.completed 里 usage 只能是 0，Codex 的 token 显示会全空。
  if (out.stream === true) {
    out.stream_options = { include_usage: true };
  }

  // 兜底：把没被显式处理、也没进 UNSUPPORTED_FIELDS 的字段全记进 dropped。
  // 这里用"已处理名单"反推而不是白名单枚举，新增字段会被自动记录，
  // 不至于悄悄消失；但也不报错——否则 Codex 每加一个字段就整轮对话失败。
  for (const key of Object.keys(body)) {
    if (
      !['model', 'input', 'instructions', 'stream', 'tools', 'tool_choice', 'text',
        'temperature', 'top_p', 'user', 'max_output_tokens', 'parallel_tool_calls',
        'stream_options', 'reasoning', ...UNSUPPORTED_FIELDS].includes(key)
    ) {
      meta.dropped.push(key);
    }
  }

  return { body: out, meta };
}
