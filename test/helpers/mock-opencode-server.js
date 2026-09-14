import http from 'node:http';

/**
 * @typedef {Object} Scenario
 * @property {'standard' | 'thinking' | 'tool-call' | 'fault' | 'drop' | 'keep-alive'} [mode='standard']
 * @property {number} [status=500] HTTP status for 'fault' mode (500, 502, 503, 401, 404)
 * @property {string} [message] Custom error message or text
 * @property {string} [content] Custom response text
 * @property {string} [contentPart1] First delta of response text
 * @property {string} [contentPart2] Second delta of response text
 * @property {string} [reasoning] Custom reasoning text for 'thinking' mode
 * @property {string} [toolName='calculator'] Tool name for 'tool-call' mode
 * @property {string} [toolCallId='call_calc_mock'] Call ID for 'tool-call' mode
 * @property {string} [toolArgsPart1] First part of tool arguments delta
 * @property {string} [toolArgsPart2] Second part of tool arguments delta
 * @property {number} [keepAliveCount=2] Number of ': keep-alive' lines to send
 * @property {string} [nextMode='standard'] Mode to execute after keep-alive
 * @property {number} [delayMs=0] Delay between chunks in ms
 * @property {Array<any>} [chunks] Custom raw SSE chunk payloads
 */

/**
 * Default scenario settings
 */
const DEFAULT_SCENARIO = {
  mode: 'standard',
};

/**
 * Standard fault message mappings
 */
const FAULT_MESSAGES = {
  401: 'OpenCode authentication failed: Invalid or expired API key.',
  404: 'OpenCode model not found in the remote catalog.',
  500: 'Internal Server Error: OpenCode upstream cluster failed.',
  502: 'Bad Gateway: Upstream OpenCode service unreachable.',
  503: 'Service Unavailable: OpenCode is temporarily overloaded.',
};

/**
 * Writes an SSE formatted message to the response stream
 * @param {http.ServerResponse} res
 * @param {any} data
 */
function writeSse(res, data) {
  if (typeof data === 'string') {
    res.write(`data: ${data}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

/**
 * Delays execution if delayMs is positive
 * @param {number} ms
 */
function delay(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Streams thinking / reasoning SSE chunks
 */
async function streamThinking(res, isResponses, body, scenario) {
  const delayMs = scenario.delayMs || 0;
  const reasoning = scenario.reasoning || 'Analyzing query step by step...';
  const content = scenario.content || 'Here is the verified response based on reasoning.';

  if (isResponses) {
    writeSse(res, {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'reason_mock_1', type: 'reasoning' },
    });
    await delay(delayMs);

    writeSse(res, {
      type: 'response.reasoning_text.delta',
      output_index: 0,
      delta: reasoning,
    });
    await delay(delayMs);

    writeSse(res, {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'reason_mock_1', type: 'reasoning' },
    });
    await delay(delayMs);

    writeSse(res, {
      type: 'response.output_text.delta',
      delta: content,
    });
    await delay(delayMs);

    writeSse(res, {
      type: 'response.completed',
      response: { id: 'resp-think-mock', status: 'completed' },
    });
  } else {
    writeSse(res, {
      id: 'chatcmpl-mock-think',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-model',
      choices: [{
        index: 0,
        delta: { role: 'assistant', reasoning_content: reasoning },
        finish_reason: null,
      }],
    });
    await delay(delayMs);

    writeSse(res, {
      id: 'chatcmpl-mock-think',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-model',
      choices: [{
        index: 0,
        delta: { content },
        finish_reason: null,
      }],
    });
    await delay(delayMs);

    writeSse(res, {
      id: 'chatcmpl-mock-think',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-model',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    });
  }

  writeSse(res, '[DONE]');
  res.end();
}

/**
 * Streams function call deltas for `calculator`
 */
async function streamToolCall(res, isResponses, body, scenario) {
  const delayMs = scenario.delayMs || 0;
  const toolName = scenario.toolName || 'calculator';
  const callId = scenario.toolCallId || 'call_calc_mock_1';
  const part1 = scenario.toolArgsPart1 || '{"expression":';
  const part2 = scenario.toolArgsPart2 || ' "2 + 2"}';

  if (isResponses) {
    writeSse(res, {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: callId,
        type: 'function_call',
        name: toolName,
        arguments: '',
      },
    });
    await delay(delayMs);

    writeSse(res, {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: part1,
    });
    await delay(delayMs);

    writeSse(res, {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: part2,
    });
    await delay(delayMs);

    writeSse(res, {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: callId,
        type: 'function_call',
        name: toolName,
      },
    });
    await delay(delayMs);

    writeSse(res, {
      type: 'response.completed',
      response: { id: 'resp-tool-mock', status: 'completed' },
    });
  } else {
    writeSse(res, {
      id: 'chatcmpl-mock-tool',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-model',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: callId,
            type: 'function',
            function: {
              name: toolName,
              arguments: '',
            },
          }],
        },
        finish_reason: null,
      }],
    });
    await delay(delayMs);

    writeSse(res, {
      id: 'chatcmpl-mock-tool',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-model',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: part1 },
          }],
        },
        finish_reason: null,
      }],
    });
    await delay(delayMs);

    writeSse(res, {
      id: 'chatcmpl-mock-tool',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-model',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: part2 },
          }],
        },
        finish_reason: null,
      }],
    });
    await delay(delayMs);

    writeSse(res, {
      id: 'chatcmpl-mock-tool',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-model',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'tool_calls',
      }],
    });
  }

  writeSse(res, '[DONE]');
  res.end();
}

/**
 * Streams standard text response SSE chunks
 */
async function streamStandard(res, isResponses, body, scenario) {
  const delayMs = scenario.delayMs || 0;
  const part1 = scenario.contentPart1 || scenario.content || 'Hello from ';
  const part2 = scenario.contentPart2 || (scenario.content ? '' : 'mock OpenCode server!');

  if (Array.isArray(scenario.chunks)) {
    for (const chunk of scenario.chunks) {
      writeSse(res, chunk);
      await delay(delayMs);
    }
    writeSse(res, '[DONE]');
    res.end();
    return;
  }

  if (isResponses) {
    writeSse(res, {
      type: 'response.output_text.delta',
      delta: part1,
    });
    await delay(delayMs);

    if (part2) {
      writeSse(res, {
        type: 'response.output_text.delta',
        delta: part2,
      });
      await delay(delayMs);
    }

    writeSse(res, {
      type: 'response.completed',
      response: { id: 'resp-std-mock', status: 'completed' },
    });
  } else {
    writeSse(res, {
      id: 'chatcmpl-mock-std',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-model',
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null,
      }],
    });
    await delay(delayMs);

    writeSse(res, {
      id: 'chatcmpl-mock-std',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-model',
      choices: [{
        index: 0,
        delta: { content: part1 },
        finish_reason: null,
      }],
    });
    await delay(delayMs);

    if (part2) {
      writeSse(res, {
        id: 'chatcmpl-mock-std',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'mock-model',
        choices: [{
          index: 0,
          delta: { content: part2 },
          finish_reason: null,
        }],
      });
      await delay(delayMs);
    }

    writeSse(res, {
      id: 'chatcmpl-mock-std',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-model',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    });
  }

  writeSse(res, '[DONE]');
  res.end();
}

/**
 * Dispatches streaming mode based on scenario configuration
 */
async function streamPayload(res, isResponses, body, scenario) {
  const mode = scenario.mode || 'standard';
  if (mode === 'thinking') {
    await streamThinking(res, isResponses, body, scenario);
  } else if (mode === 'tool-call') {
    await streamToolCall(res, isResponses, body, scenario);
  } else {
    await streamStandard(res, isResponses, body, scenario);
  }
}

/**
 * Starts a deterministic wire-level mock OpenCode HTTP server.
 *
 * @param {number} [port=0] Port to listen on (0 for dynamic OS-allocated port)
 * @returns {Promise<{
 *   url: string,
 *   port: number,
 *   server: http.Server,
 *   close(): Promise<void>,
 *   setScenario(s: Scenario | string | Array<Scenario | string>): void,
 *   queueScenario(s: Scenario | string): void,
 *   resetScenarios(): void,
 *   getScenario(): Scenario,
 *   requests: Array<any>,
 *   getRequests(): Array<any>,
 *   clearRequests(): void
 * }>}
 */
export async function startMockServer(port = 0) {
  let currentScenario = { ...DEFAULT_SCENARIO };
  const scenarioQueue = [];
  const requests = [];
  const activeSockets = new Set();

  const server = http.createServer(async (req, res) => {
    // Collect request body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8');
    let body = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    const host = req.headers.host || '127.0.0.1';
    const parsedUrl = new URL(req.url || '/', `http://${host}`);
    const pathname = parsedUrl.pathname.replace(/\/$/, '') || '/';

    // Record request for test assertions
    const requestRecord = {
      method: req.method,
      url: req.url,
      pathname,
      headers: req.headers,
      body,
      rawBody,
      timestamp: Date.now(),
    };
    requests.push(requestRecord);

    // Support CORS preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Determine target API
    const isChat = pathname === '/zen/v1/chat/completions' || pathname === '/zen/go/v1/chat/completions';
    const isResponses = pathname === '/zen/v1/responses' || pathname === '/zen/go/v1/responses';
    const isModels = pathname === '/zen/v1/models' || pathname === '/zen/go/v1/models';

    // Models endpoint helper
    if (isModels) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'deepseek-v4-pro' },
          { id: 'minimax-m3' },
          { id: 'big-pickle' },
          { id: 'mimo-v2.5-free' },
          { id: 'kimi-k3' },
          { id: 'glm-5.2' },
        ],
      }));
      return;
    }

    if (!isChat && !isResponses) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Endpoint not found: ${pathname}`,
          type: 'not_found_error',
          code: 404,
        },
      }));
      return;
    }

    // Resolve scenario: queue takes precedence over default
    let activeScenario = scenarioQueue.shift() || currentScenario;
    if (typeof activeScenario === 'string') {
      activeScenario = { mode: activeScenario };
    }

    const mode = activeScenario.mode || 'standard';

    // 1. Fault injection mode (500, 502, 503, 401, 404)
    if (mode === 'fault') {
      const status = activeScenario.status || 500;
      const message = activeScenario.message || FAULT_MESSAGES[status] || `OpenCode fault simulation (${status})`;
      const type =
        status === 401 ? 'authentication_error' :
        status === 404 ? 'not_found_error' :
        status >= 500 ? 'server_error' : 'invalid_request_error';

      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({
        error: {
          message,
          type,
          code: status,
        },
      }));
      return;
    }

    // 2. Socket drop mode (abrupt disconnect midway through SSE)
    if (mode === 'drop') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      if (isResponses) {
        writeSse(res, {
          type: 'response.output_text.delta',
          delta: 'Initial partial response before drop...',
        });
      } else {
        writeSse(res, {
          id: 'chatcmpl-drop',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'mock-model',
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: 'Initial partial response before drop...' },
            finish_reason: null,
          }],
        });
      }

      // Abruptly destroy socket after a slight tick to ensure bytes leave the write buffer
      setTimeout(() => {
        const socket = res.socket || req.socket;
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      }, 10);
      return;
    }

    // 3. Keep-alive mode (sends comment lines before streaming response)
    if (mode === 'keep-alive') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const count = activeScenario.keepAliveCount || 2;
      for (let i = 0; i < count; i++) {
        res.write(': keep-alive\n\n');
        if (activeScenario.delayMs) {
          await delay(activeScenario.delayMs);
        }
      }

      const nextMode = activeScenario.nextMode || 'standard';
      await streamPayload(res, isResponses, body, { ...activeScenario, mode: nextMode });
      return;
    }

    // 4. Standard, Thinking, and Tool-call modes
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    await streamPayload(res, isResponses, body, activeScenario);
  });

  // Track sockets for prompt, graceful teardown without dangling connections
  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}`;

  return {
    url,
    port: actualPort,
    server,
    close: async () => {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    setScenario: (s) => {
      if (Array.isArray(s)) {
        scenarioQueue.length = 0;
        for (const item of s) {
          scenarioQueue.push(typeof item === 'string' ? { mode: item } : { ...item });
        }
      } else if (typeof s === 'string') {
        currentScenario = { mode: s };
      } else if (s && typeof s === 'object') {
        currentScenario = { ...s };
      }
    },
    queueScenario: (s) => {
      scenarioQueue.push(typeof s === 'string' ? { mode: s } : { ...s });
    },
    resetScenarios: () => {
      currentScenario = { ...DEFAULT_SCENARIO };
      scenarioQueue.length = 0;
    },
    getScenario: () => ({ ...currentScenario }),
    requests,
    getRequests: () => [...requests],
    clearRequests: () => {
      requests.length = 0;
    },
  };
}
