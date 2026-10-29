/**
 * 冒烟用的假上游：同时提供 OpenAI 与 Anthropic 形态的 /models 与流式接口，
 * 用于验证网关转发、别名解析、流式透传与失败回退。
 */
import http from 'node:http';

const OPENAI_MODELS = {
  data: [
    // 带 metadata：用于验证"上游声明的上下文窗口会被解析并落进模型目录"。
    // 只给 gpt-x 带元数据，gpt-x-mini 不带，好断言"没有声明时不瞎猜"。
    {
      id: 'gpt-x',
      metadata: { context_limit: 400_000, output_budget: 64_000 },
    },
    { id: 'gpt-x-mini' },
    // 生图模型：输出模态只有 image（没有 text），应被归到 imageModels。
    {
      id: 'img-only-model',
      architecture: { output_modalities: ['image'], input_modalities: ['text', 'image'] },
    },
    // 多模态：既能输出图像也能输出文本，仍属对话模型——挪进生图列表会让用户在
    // Codex 里看不到它，所以判据是"没有 text"而不是"含 image"。
    {
      id: 'omni-chat-model',
      architecture: { output_modalities: ['text', 'image'], input_modalities: ['text'] },
    },
    // 没声明 architecture：不做任何假设，留在对话模型里由用户自己填。
    { id: 'undeclared-modal-model' },
  ],
};
const ANTHROPIC_MODELS = { data: [{ id: 'claude-x' }] };

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
  });
}

/** 一张 1x1 的透明 PNG，用于模拟"网关把 url 下载下来内联成 b64"的下游资源。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 生图请求打到 mock 的次数，供用例断言"上游本来就返 b64 时网关不去下载"。 */
export const imageStats = { generationRequests: 0, assetDownloads: 0 };

export function resetImageStats(): void {
  imageStats.generationRequests = 0;
  imageStats.assetDownloads = 0;
}

export function startMockUpstream(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    // 生图资源：模拟上游返回的预签名图片链接
    if (req.method === 'GET' && url.includes('/image-asset')) {
      imageStats.assetDownloads += 1;
      // 用 `broken=1` 模拟"预签名链接过期，返回 200 的 HTML 错误页"这一常见故障
      if (url.includes('broken=1')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>expired</html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }

    if (req.method === 'GET' && url.endsWith('/models')) {
      const isAnthropic = (req.headers['x-api-key'] as string | undefined) !== undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(isAnthropic ? ANTHROPIC_MODELS : OPENAI_MODELS));
      return;
    }

    if (req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');

      if (url.includes('/images/')) {
        imageStats.generationRequests += 1;
        // 默认复刻实测到的上游行为：**只给 url，不给 b64_json**
        // （本机 OpenDesign 对 Codex 原样请求体就是 `data[0].keys = ["url","index"]`）。
        // 模型名里带 `inline-` 时改为直接返 b64，用于验证"上游已给 b64 时网关不下载"。
        const wantsInline = typeof body.model === 'string' && body.model.includes('inline-');
        // 模型名里带 `broken-` 时返回一个"状态 200 但不是图片"的链接，
        // 复刻预签名链接过期后返回 HTML 错误页这一常见故障。
        const brokenAsset = typeof body.model === 'string' && body.model.includes('broken-');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            created: 1_800_000_000,
            model: body.model,
            data: [
              wantsInline
                ? { b64_json: TINY_PNG.toString('base64'), index: 0, echo_model: body.model }
                : {
                    url: `http://127.0.0.1:${portOf(server)}/image-asset.png${brokenAsset ? '?broken=1' : ''}`,
                    index: 0,
                    echo_model: body.model,
                    // 回显请求里的 prompt / images，便于断言透传未改写
                    echo_prompt: body.prompt,
                    echo_images: body.images,
                  },
            ],
          }),
        );
        return;
      }

      if (url.includes('/chat/completions')) {
        if (body.stream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          });
          const chunks = ['Hello', ' from', ' fake', ' upstream'];
          for (const chunk of chunks) {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
            );
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'mock reply' } }],
          }),
        );
        return;
      }

      if (url.includes('/responses')) {
        // OpenAI Responses API 形态：与 chat completions 明显不同的响应结构，
        // 便于断言请求确实打到了 responses 上游而非被当成 chat 处理。
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'resp_mock',
            object: 'response',
            model: body.model,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'mock responses reply' }],
              },
            ],
          }),
        );
        return;
      }

      if (url.includes('/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'mock anthropic reply' }],
            model: body.model,
          }),
        );
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise<http.Server>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** 永远返回 500 的假上游，用于验证故障转移。 */
export function startFailingUpstream(port = 0) {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream down' } }));
  });
  return new Promise<http.Server>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/**
 * 永远返回指定 4xx 的假上游，用于验证"非 5xx 不回退、但错误必须透传给客户端"。
 * 4xx 是请求本身的问题（模型名、参数、额度、鉴权），换供应商大概率同样失败。
 */
export function startClientErrorUpstream(status = 429, port = 0) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 'rate_limit_exceeded', message: `upstream says ${status}` },
      }),
    );
  });
  return new Promise<http.Server>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** 取服务实际监听的端口（传入 0 时由系统分配，避免与外部进程撞端口）。 */
export function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('无法获取 mock 上游端口');
  }
  return address.port;
}
