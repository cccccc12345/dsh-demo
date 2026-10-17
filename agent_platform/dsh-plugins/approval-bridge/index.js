/**
 * 把 dsh 的 approval/request 转发给平台,等待人工批准/拒绝。
 *
 * 平台在启动时通过 env 注入:
 * - AGENT_APPROVAL_URL: 本地回调地址
 * - AGENT_APPROVAL_TOKEN: 回调鉴权 token
 * - AGENT_APPROVAL_TIMEOUT_MS: fetch 的最长等待时间(应大于后端审批超时)
 *
 * 没有 URL、回调失败或超时都 fail closed,返回 unavailable/rejected。
 */
export const name = 'approval-bridge'
export const inject = ['approval']

export function apply(ctx) {
  // 可选:对指定工具强制走审批,例如 DSH_APPROVAL_TOOLS=bash,write,edit。
  const gatedTools = new Set(
    (process.env.AGENT_APPROVAL_TOOLS || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  )
  if (gatedTools.size > 0) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!gatedTools.has(exec.name)) return next()
      return { kind: 'ask', reason: `工具 ${exec.name} 需要人工审批` }
    })
  }

  ctx.on('approval/request', async (req, next) => {
    const url = process.env.AGENT_APPROVAL_URL
    const token = process.env.AGENT_APPROVAL_TOKEN || ''
    if (!url) return next()

    const timeoutMs = Number(process.env.AGENT_APPROVAL_TIMEOUT_MS || '180000')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
    const forwardAbort = () => controller.abort()
    if (req.signal) {
      if (req.signal.aborted) controller.abort()
      else req.signal.addEventListener('abort', forwardAbort, { once: true })
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-approval-token': token,
        },
        body: JSON.stringify({
          sessionId: req.agent?.session?.id || '',
          toolName: req.toolName || 'tool',
          callId: req.callId,
          reason: req.reason || '',
        }),
        signal: controller.signal,
      })
      if (!response.ok) return next()
      const data = await response.json()
      if (
        data?.outcome === 'allowed-once' ||
        data?.outcome === 'rejected' ||
        data?.outcome === 'cancelled' ||
        data?.outcome === 'unavailable'
      ) {
        return data.outcome
      }
      return 'unavailable'
    } catch (error) {
      if (req.signal?.aborted) return 'cancelled'
      console.error('[approval-bridge] 审批回调失败:', error)
      return 'unavailable'
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', forwardAbort)
    }
  })
}
