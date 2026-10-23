/**
 * 跨协议转换（Responses ←→ Chat）的单元测试。
 *
 * 这一层是纯函数，所以这里断言的是**映射契约本身**，不经过 HTTP。
 * 端到端行为（自动开启、开关关闭仍 501、流式真的发到客户端）在 smoke.test.ts。
 *
 * 这些断言存在的意义：转换一旦"看起来能跑但细节错了"，症状会非常难查——
 * 上游不报错、Codex 也不报错，只是工具调用执行不了、或者思考区一直转圈。
 * 所以每条用例都钉住一个具体的下游消费点，而不是只比对整体形状。
 */
import { describe, expect, it } from 'vitest';
import { ConversionError, responsesToChatRequest } from '../src/gateway/convert/responsesToChat';
import { chatToResponsesResponse } from '../src/gateway/convert/chatToResponses';
import {
  ChatStreamToResponsesConverter,
  serializeResponsesEvent,
  type ResponsesStreamEvent,
} from '../src/gateway/convert/chatToResponsesStream';

describe('Responses → Chat 请求转换', () => {
  it('instructions 变成 system，字符串 input 变成 user', () => {
    const { body } = responsesToChatRequest(
      { instructions: '你是助手', input: '你好', model: 'ignored' },
      'gpt-x',
    );
    expect(body.model).toBe('gpt-x');
    expect(body.messages).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ]);
  });

  it('input 数组里 function_call 挂到 assistant，output 变成 tool 消息', () => {
    const { body } = responsesToChatRequest(
      {
        input: [
          { type: 'message', role: 'user', content: '列出文件' },
          { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
        ],
      },
      'gpt-x',
    );
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
      ],
    });
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'a.txt' });
  });

  it('custom 工具定义转成单参数 function', () => {
    const { body } = responsesToChatRequest(
      {
        input: 'hi',
        tools: [{ type: 'custom', name: 'apply_patch', description: '打补丁' }],
      },
      'gpt-x',
    );
    // custom 工具不能透传（Chat 不认），也不能丢（模型会看不到这个工具）
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          description: '打补丁',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: '打补丁' } },
            required: ['input'],
          },
        },
      },
    ]);
  });

  it('custom_tool_call 编码成参数为 {input} 的 function 调用', () => {
    const { body } = responsesToChatRequest(
      {
        input: [
          { type: 'message', role: 'user', content: '打补丁' },
          { type: 'custom_tool_call', call_id: 'call_c', name: 'apply_patch', input: '*** Begin Patch' },
        ],
      },
      'gpt-x',
    );
    const messages = body.messages as Array<Record<string, unknown>>;
    const assistant = messages[1];
    const calls = assistant.tool_calls as Array<Record<string, unknown>>;
    expect(assistant.role).toBe('assistant');
    expect(calls[0].id).toBe('call_c');
    // 参数必须是合法 JSON，且把原始文本放在 input 里
    expect(JSON.parse(String((calls[0].function as Record<string, unknown>).arguments))).toEqual({
      input: '*** Begin Patch',
    });
  });

  it('custom_tool_call_output 回填成 tool 消息', () => {
    const { body } = responsesToChatRequest(
      {
        input: [
          { type: 'custom_tool_call', call_id: 'call_c', name: 'apply_patch', input: 'x' },
          { type: 'custom_tool_call_output', call_id: 'call_c', output: '已应用' },
        ],
      },
      'gpt-x',
    );
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({ role: 'tool', tool_call_id: 'call_c', content: '已应用' });
  });

  it('工具定义从扁平结构改成嵌套 function', () => {
    const { body } = responsesToChatRequest(
      {
        input: 'hi',
        tools: [
          { type: 'function', name: 'shell', description: '跑命令', parameters: { type: 'object' } },
        ],
      },
      'gpt-x',
    );
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'shell', description: '跑命令', parameters: { type: 'object' } } },
    ]);
  });

  it('托管工具（web_search）无法转换时被记录而不是报错', () => {
    const { body, meta } = responsesToChatRequest(
      { input: 'hi', tools: [{ type: 'web_search' }, { type: 'function', name: 'f', parameters: {} }] },
      'gpt-x',
    );
    expect(meta.dropped).toContain('tools.web_search');
    expect((body.tools as unknown[]).length).toBe(1);
  });

  it('依赖会话状态的字段明确报错，不静默丢弃', () => {
    expect(() => responsesToChatRequest({ input: 'hi', previous_response_id: 'r1' }, 'm')).toThrow(
      ConversionError,
    );
    expect(() => responsesToChatRequest({ input: 'hi', conversation: 'c1' }, 'm')).toThrow(
      ConversionError,
    );
  });

  it('max_output_tokens 映射为 max_tokens，流式补 include_usage', () => {
    const { body } = responsesToChatRequest(
      { input: 'hi', max_output_tokens: 256, stream: true },
      'gpt-x',
    );
    expect(body.max_tokens).toBe(256);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('图片输入转成 Chat 的 image_url 内容块', () => {
    const { body } = responsesToChatRequest(
      {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '这是什么' },
              { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'high' },
            ],
          },
        ],
      },
      'gpt-x',
    );
    const message = (body.messages as Array<Record<string, unknown>>)[0];
    expect(message.content).toEqual([
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } },
    ]);
  });

  it('只有文本时内容降级成字符串（老上游只认字符串）', () => {
    const { body } = responsesToChatRequest(
      {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '第一段' }, { type: 'input_text', text: '第二段' }],
          },
        ],
      },
      'gpt-x',
    );
    expect((body.messages as Array<Record<string, unknown>>)[0].content).toBe('第一段第二段');
  });

  it('reasoning.effort 映射为 Chat 的 reasoning_effort', () => {
    const { body, meta } = responsesToChatRequest(
      { input: 'hi', reasoning: { effort: 'high', summary: 'auto' } },
      'gpt-x',
    );
    expect(body.reasoning_effort).toBe('high');
    // summary 是"要不要回传思考摘要"，Chat 没有对应开关
    expect(meta.dropped).toContain('reasoning.summary');
  });

  it('reasoning.effort 取 none 时同样透传', () => {
    const { body } = responsesToChatRequest({ input: 'hi', reasoning: { effort: 'none' } }, 'gpt-x');
    expect(body.reasoning_effort).toBe('none');
  });

  it('未知的 effort 透传而不是静默丢弃', () => {
    const { body } = responsesToChatRequest(
      { input: 'hi', reasoning: { effort: 'ultra' } },
      'gpt-x',
    );
    // 让上游自己报错，比我们吞掉更容易发现版本不匹配
    expect(body.reasoning_effort).toBe('ultra');
  });

  it('空 input 报错而不是发出一个没内容的请求', () => {
    expect(() => responsesToChatRequest({ input: [] }, 'm')).toThrow(ConversionError);
  });
});

describe('Chat → Responses 响应转换', () => {
  // Codex 解析的是 Responses 的 `output[]`，不是 Chat 的 `choices[]`。
  // 形状错了它不会报错，只会认为"模型没有输出"——所以这里逐项钉住类型与字段。
  it('正文与工具调用都进入 output 数组', () => {
    const out = chatToResponsesResponse({
      model: 'gpt-x',
      chat: {
        id: 'chatcmpl-1',
        model: 'gpt-x',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '我来执行',
              tool_calls: [
                { id: 'call_9', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });

    expect(out.object).toBe('response');
    expect(out.status).toBe('completed');
    const output = out.output as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: '我来执行', annotations: [] }],
    });
    // call_id 必须保留：下一轮 function_call_output 靠它对应
    expect(output[1]).toMatchObject({ type: 'function_call', call_id: 'call_9', name: 'shell' });
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it('custom 工具的调用还原成 custom_tool_call，参数拆回原始文本', () => {
    const out = chatToResponsesResponse({
      model: 'gpt-x',
      customToolNames: new Set(['apply_patch']),
      chat: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_c',
                  type: 'function',
                  function: { name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch' }) },
                },
              ],
            },
          },
        ],
      },
    });
    const output = out.output as Array<Record<string, unknown>>;
    // 类型必须是 custom_tool_call，不能是 function_call：
    // Codex 按 item.type 决定下一轮回传什么。给它 function_call，它会回
    // function_call_output，而模型被声明成 custom 工具，两边对不上，
    // 表现为"补丁工具时好时坏"——很难和上游质量联系起来。
    expect(output[0]).toMatchObject({
      type: 'custom_tool_call',
      call_id: 'call_c',
      name: 'apply_patch',
      input: '*** Begin Patch',
    });
  });

  // 反向保护：custom 名单只对名单里的名字生效。若实现写成"只要是工具调用就转
  // custom_tool_call"，普通 shell 调用会被误判成自由文本工具，参数结构也会丢。
  it('普通 function 调用不受 custom 名单影响', () => {
    const out = chatToResponsesResponse({
      model: 'gpt-x',
      customToolNames: new Set(['apply_patch']),
      chat: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
              ],
            },
          },
        ],
      },
    });
    const output = out.output as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({ type: 'function_call', name: 'shell' });
  });

  it('finish_reason=length 映射成 incomplete', () => {
    const out = chatToResponsesResponse({
      model: 'gpt-x',
      chat: { choices: [{ finish_reason: 'length', message: { content: 'abc' } }] },
    });
    expect(out.status).toBe('incomplete');
    expect(out.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('没有文本时不产出空 message 项', () => {
    const out = chatToResponsesResponse({
      model: 'gpt-x',
      chat: { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
    });
    expect(out.output).toEqual([]);
  });
});

describe('Chat SSE → Responses SSE 流式转换', () => {
  // 流式是最容易"看起来能跑"的部分：事件发出来了，但顺序、序号或收尾错了，
  // Codex 会卡在"进行中"或直接把这一轮判为失败。下面几条分别钉住这些点：
  // - sequence_number 必须从 0 开始严格 +1（客户端按它排序/去重）
  // - 正文、推理、工具调用都必须补 done，缺一个对应区域就一直转圈
  // - 工具参数必须拼完整才发 done，否则 Codex 会执行一个被截断的命令
  const collect = (lines: string[]): ResponsesStreamEvent[] => {
    const converter = new ChatStreamToResponsesConverter('gpt-x', 'resp_test');
    const events: ResponsesStreamEvent[] = [];
    for (const line of lines) events.push(...converter.feedLine(line));
    return events;
  };

  const line = (payload: unknown): string => `data: ${JSON.stringify(payload)}`;

  it('文本流产出 created → output_item.added → delta → done → completed', () => {
    const events = collect([
      line({ choices: [{ delta: { content: '你' } }] }),
      line({ choices: [{ delta: { content: '好' } }] }),
      line({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]',
    ]);
    const names = events.map((item) => item.event);

    expect(names[0]).toBe('response.created');
    expect(names).toContain('response.output_item.added');
    expect(names.filter((name) => name === 'response.output_text.delta')).toHaveLength(2);
    expect(names).toContain('response.output_item.done');
    expect(names[names.length - 1]).toBe('response.completed');

    // delta 事件只是增量，客户端会自己拼。这里确认拼接结果与原文一致，
    // 防止"少发一段/多发一段"这种只在长回答下才暴露的问题。
    const deltas = events
      .filter((item) => item.event === 'response.output_text.delta')
      .map((item) => item.data.delta)
      .join('');
    expect(deltas).toBe('你好');

    // sequence_number 从 0 起严格 +1：Codex 按它判断事件顺序与是否丢帧。
    // 中间跳号/回退会让它丢弃后续事件，表现为"流突然断了但没有报错"。
    const sequences = events.map((item) => Number(item.data.sequence_number));
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBe(sequences[i - 1] + 1);
    }
  });

  it('工具调用产出 function_call 项与参数增量', () => {
    const events = collect([
      line({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'shell', arguments: '{"cmd"' } },
              ],
            },
          },
        ],
      }),
      line({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }],
      }),
      line({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]',
    ]);

    const added = events.find((item) => item.event === 'response.output_item.added');
    expect((added?.data.item as Record<string, unknown>).type).toBe('function_call');

    const argsDone = events.find((item) => item.event === 'response.function_call_arguments.done');
    // 参数在上游是分块到达的（'{"cmd"' + ':"ls"}'），这里断言两件事：
    // 1) done 事件里的 arguments 必须是拼好的完整 JSON —— Codex 直接拿它去执行命令，
    //    只发最后一块或发半截，命令会被静默执行成别的意思。
    expect(argsDone?.data.arguments).toBe('{"cmd":"ls"}');

    // 2) done 事件里的 item 同样要带完整参数。Codex 用 item.done 落历史，
    //    两者不一致会导致"历史里的调用参数"和"实际执行的不同"。
    const itemDone = events
      .filter((item) => item.event === 'response.output_item.done')
      .map((item) => item.data.item as Record<string, unknown>)
      .find((item) => item.type === 'function_call');
    expect(itemDone?.arguments).toBe('{"cmd":"ls"}');
    expect(itemDone?.call_id).toBe('call_1');
  });

  it('推理增量产出 reasoning 项并完整收尾', () => {
    const events = collect([
      line({ choices: [{ delta: { reasoning_content: '想一想' } }] }),
      line({ choices: [{ delta: { content: '答案' } }] }),
      line({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]',
    ]);
    const names = events.map((item) => item.event);

    const added = events.find(
      (item) =>
        item.event === 'response.output_item.added' &&
        (item.data.item as Record<string, unknown>).type === 'reasoning',
    );
    expect(added).toBeTruthy();
    expect(names).toContain('response.reasoning_summary_text.delta');
    // 正文与推理都要有 done，否则 Codex 里对应区域一直显示"进行中"。
    // 推理还多一层：summary_text.done 与 summary_part.done 都要发，
    // 只发其中一个，折叠区标题仍会转圈。
    expect(names).toContain('response.reasoning_summary_text.done');
    expect(names).toContain('response.reasoning_summary_part.done');
    expect(names.filter((name) => name === 'response.output_item.done')).toHaveLength(2);
  });

  it('流式 custom 工具产出 custom_tool_call 并把 input 拆回原文', () => {
    const converter = new ChatStreamToResponsesConverter(
      'gpt-x',
      'resp_test',
      new Set(['apply_patch']),
    );
    const events: ResponsesStreamEvent[] = [];
    for (const chunk of [
      line({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_c', function: { name: 'apply_patch', arguments: '{"input"' } },
              ],
            },
          },
        ],
      }),
      line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ': "patch"}' } }] } }] }),
      line({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]',
    ]) {
      events.push(...converter.feedLine(chunk));
    }

    const added = events.find((item) => item.event === 'response.output_item.added');
    expect((added?.data.item as Record<string, unknown>).type).toBe('custom_tool_call');

    // custom 工具在 Responses 里没有 `custom_tool_call_input.delta` 这类增量事件，
    // 所以不能套用 function_call 的 arguments.delta。这里反向断言"没发"，
    // 防止后来者顺手复用 function_call 的分支，发出 Codex 不认识的事件。
    expect(events.some((item) => item.event === 'response.function_call_arguments.delta')).toBe(false);

    const itemDone = events
      .filter((item) => item.event === 'response.output_item.done')
      .map((item) => item.data.item as Record<string, unknown>)
      .find((item) => item.type === 'custom_tool_call');
    expect(itemDone?.input).toBe('patch');
    expect(itemDone?.call_id).toBe('call_c');
  });

  it('arguments 先于 name 到达时不丢参数', () => {
    // 真实 bug：`call.args += argsDelta` 原本被 `call.added` 拦住，
    // 而 added 要等 name 到齐。有的聚合上游把 name 分段拼在后面的 chunk 里，
    // 首个 chunk 的参数就被静默丢弃 → Codex 拿残缺 JSON 执行命令，且无任何日志。
    const converter = new ChatStreamToResponsesConverter('gpt-x', 'resp_test');
    const events: ResponsesStreamEvent[] = [];
    for (const chunk of [
      line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'PRE' } }] } }] }),
      line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'shell', arguments: 'POST' } }] } }] }),
      'data: [DONE]',
    ]) {
      events.push(...converter.feedLine(chunk));
    }
    const done = events.find(
      (item) => item.event === 'response.output_item.done' && (item.data.item as Record<string, unknown>).type === 'function_call',
    );
    expect((done?.data.item as Record<string, unknown>).arguments).toBe('PREPOST');
  });

  it('上游 error 之后 finish() 不再补发 completed', () => {
    // forward.ts 在读到 EOF 后**总会**调 finish()。若 error 分支不标记已结束，
    // 就会在 response.failed 之后继续补 output_item.done 与 response.completed，
    // 同一轮既失败又成功——协议违规，Codex 侧会记录自相矛盾的状态。
    const converter = new ChatStreamToResponsesConverter('gpt-x', 'resp_test');
    const events: ResponsesStreamEvent[] = [];
    events.push(...converter.feedLine(line({ choices: [{ delta: { content: 'x' } }] })));
    events.push(...converter.feedLine(line({ error: { code: 'bad', message: '上游炸了' } })));
    // 关键：模拟 forward.ts 的收尾
    events.push(...converter.finish());

    const names = events.map((item) => item.event);
    expect(names).toContain('response.failed');
    expect(names).not.toContain('response.completed');
  });

  it('上游 error 事件转成 response.failed', () => {
    const events = collect([line({ error: { code: 'bad', message: '上游炸了' } })]);
    const failed = events.find((item) => item.event === 'response.failed');
    expect(failed).toBeTruthy();
    const response = failed?.data.response as Record<string, unknown>;
    expect(response.status).toBe('failed');
  });

  it('空行、注释、坏 JSON 都被跳过而不中断流', () => {
    const events = collect([
      '',
      ': keep-alive',
      'data: {broken json',
      line({ choices: [{ delta: { content: 'ok' } }] }),
      'data: [DONE]',
    ]);
    expect(events.some((item) => item.event === 'response.output_text.delta')).toBe(true);
    expect(events[events.length - 1].event).toBe('response.completed');
  });

  it('序列化后是合法的 SSE 帧', () => {
    const [event] = collect([line({ choices: [{ delta: { content: 'x' } }] })]);
    const text = serializeResponsesEvent(event);
    expect(text.startsWith('event: response.created\ndata: ')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(true);
  });
});
