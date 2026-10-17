/**
 * Forward dsh's process-local `agent/assistant-stream` frames to the SDK
 * client as JSON-RPC notifications.
 *
 * The SDK JSON-RPC server forwards durable `session.event` and `session.status`
 * notifications, but not the transient assistant stream. Writing a valid
 * JSON-RPC notification here is enough: the Python client parses every line
 * on stdout as JSON-RPC and dispatches unknown methods as notifications.
 */
export const name = 'assistant-stream-forwarder'

export function apply(ctx) {
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = agent?.session?.id
    if (!sessionId || !frame) return
    try {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'agent/assistant-stream',
          params: { sessionId, frame },
        }) + '\n',
      )
    } catch {
      // The SDK client may have closed; never break the agent loop.
    }
  })
}
