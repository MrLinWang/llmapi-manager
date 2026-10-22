/**
 * 冒烟用的假上游：同时提供 OpenAI 与 Anthropic 形态的 /models 与流式接口，
 * 用于验证网关转发、别名解析、流式透传与失败回退。
 */
import http from 'node:http';

const OPENAI_MODELS = { data: [{ id: 'gpt-x' }, { id: 'gpt-x-mini' }] };
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

export function startMockUpstream(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (req.method === 'GET' && url.endsWith('/models')) {
      const isAnthropic = (req.headers['x-api-key'] as string | undefined) !== undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(isAnthropic ? ANTHROPIC_MODELS : OPENAI_MODELS));
      return;
    }

    if (req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');

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

/** 取服务实际监听的端口（传入 0 时由系统分配，避免与外部进程撞端口）。 */
export function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('无法获取 mock 上游端口');
  }
  return address.port;
}
