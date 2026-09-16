import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger, fingerprint } from './logger';
import { McpAuthError, authenticateToken, extractToken } from './auth';
import { createMcpServer } from './server';
import type { SessionManager } from './session-manager';

const logger = createLogger({ name: 'mcp:handler' });

const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Upper bound on how long a single JSON-RPC message may take to process. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Handle a POST /mcp request.
 *
 * Fully stateless: each request creates a fresh McpServer driven by InMemoryTransport.
 * Auth context is the only thing persisted — stored in Redis by session ID.
 * Works across any number of API instances with no sticky-session requirement.
 *
 * - No session ID: authenticate + must be an `initialize` request → create session in Redis.
 * - Session ID found in Redis: look up context, process request on a fresh server.
 * - Session ID not in Redis: 404 → client reinitializes.
 */
export async function handleMcpPost(
  sessionManager: SessionManager,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  query: Record<string, unknown>,
): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // Guard the body shape before using `in` on it — a null/primitive body would
  // otherwise throw a TypeError at `'method' in message`.
  if (typeof body !== 'object' || body === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON-RPC message' }));
    return;
  }
  const message = body as JSONRPCMessage;

  logger.info(
    {
      session: fingerprint(sessionId),
      method: 'method' in message ? message.method : 'unknown',
      hasAuth: !!(query['token'] || req.headers.authorization),
    },
    'MCP POST request',
  );

  if (sessionId) {
    const context = await sessionManager.getContext(sessionId);
    if (!context) {
      logger.warn(
        { session: fingerprint(sessionId) },
        'MCP session not found in Redis',
      );
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'Session not found — please reconnect' }),
      );
      return;
    }

    await sessionManager.touchContext(sessionId);

    // Notifications have no `id` and expect no response
    if (!('id' in message)) {
      res.writeHead(202);
      res.end();
      return;
    }

    try {
      const response = await processRequest(context, message);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sessionId,
      });
      res.end(JSON.stringify(response));
    } catch (err) {
      logger.error(
        { err, session: fingerprint(sessionId) },
        'MCP request processing error',
      );
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return;
  }

  // New connection — authenticate and expect `initialize`
  const token = extractToken(query, req.headers.authorization);

  try {
    const context = await authenticateToken(token);

    if (!('method' in message) || message.method !== 'initialize') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'First request must be initialize' }));
      return;
    }

    // `initialize` must be a request (has an id), not a notification — a
    // notification produces no response, so processRequest would wait forever.
    if (!('id' in message) || message.id === null || message.id === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'initialize must be a request with an id' }),
      );
      return;
    }

    const response = await processRequest(context, message, true);
    const newSessionId = sessionManager.generateId();
    await sessionManager.setContext(newSessionId, context);

    logger.info(
      {
        session: fingerprint(newSessionId),
        clientType: context.clientType,
        organizationId: context.organizationId,
        projectId: context.projectId,
      },
      'MCP session created',
    );

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': newSessionId,
    });
    res.end(JSON.stringify(response));
  } catch (err) {
    if (err instanceof McpAuthError) {
      logger.warn({ reason: err.message }, 'MCP auth failed');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } else {
      logger.error({ err }, 'MCP session creation error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
}

/**
 * Create a fresh McpServer for each request and process a single JSON-RPC message.
 *
 * For non-initialize requests we fast-forward the server through the MCP
 * initialization handshake (using an internal fake initialize) before dispatching
 * the real message. This keeps the handler stateless while satisfying the SDK's
 * internal state machine.
 */
async function processRequest(
  context: Parameters<typeof createMcpServer>[0],
  message: JSONRPCMessage,
  isInitialize = false,
): Promise<JSONRPCMessage> {
  if (
    'method' in message &&
    message.method === 'tools/call' &&
    'params' in message
  ) {
    const { name, arguments: args } = (message.params ?? {}) as {
      name?: string;
      arguments?: unknown;
    };
    // Never log `args` — they carry user identity ids, property filters and other
    // values that must stay inside the analytics access boundary. Name + a count
    // of argument keys is enough to trace a call.
    logger.info(
      {
        tool: name,
        argKeys:
          args && typeof args === 'object' ? Object.keys(args).length : 0,
        organizationId: context.organizationId,
        projectId: context.projectId,
        clientType: context.clientType,
      },
      'MCP tool call',
    );
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer(context);
  await server.connect(serverTransport);

  if (!isInitialize) {
    // Fast-forward: send a fake initialize so the server enters its ready state
    await new Promise<void>((resolve, reject) => {
      clientTransport.onmessage = () => resolve();
      clientTransport
        .send({
          jsonrpc: '2.0',
          id: '__mcp_init__',
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'mcp-proxy', version: '0' },
          },
        })
        .catch(reject);
    });
    // Notify the server that initialization is complete (no response expected)
    await clientTransport.send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  }

  const start = Date.now();
  const response = await new Promise<JSONRPCMessage>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('MCP request timed out')),
      REQUEST_TIMEOUT_MS,
    );
    clientTransport.onmessage = (msg) => {
      clearTimeout(timer);
      resolve(msg);
    };
    clientTransport.send(message).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  if ('method' in message && message.method === 'tools/call') {
    const { name } = (('params' in message && message.params) ?? {}) as {
      name?: string;
    };
    const isError =
      'result' in response &&
      (response.result as { isError?: boolean })?.isError;
    logger.info(
      {
        tool: name,
        durationMs: Date.now() - start,
        isError: isError ?? false,
      },
      'MCP tool result',
    );
  }

  return response;
}

/**
 * SSE is not supported in stateless mode — all communication happens over POST.
 */
export async function handleMcpGet(
  _sessionManager: SessionManager,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.writeHead(405, {
    'Content-Type': 'application/json',
    Allow: 'POST, DELETE',
  });
  res.end(
    JSON.stringify({ error: 'SSE not supported — use POST for all requests' }),
  );
}
