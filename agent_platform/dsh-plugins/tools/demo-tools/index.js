/**
 * 原生 function-calling 工具 demo。
 *
 * 模型会看到 text_stats 的 name / description / parameters(JSON Schema),
 * 调用后 runtime 执行这里的 execute(),把返回值按 output.schema 校验,
 * 再用 output.render 转成模型/UI 可读的内容。
 *
 * 这个插件刻意不 import 任何 @deepseek-ai/* 包:
 * SDK runtime 是单文件打包,外部插件目录不会自动解析这些包。
 * 用 ctx.tools.register({...}) 的原始定义即可,零依赖。
 */
export const name = 'demo-tools'
export const inject = ['tools', 'approval']

export function apply(ctx) {
  ctx.tools.register({
    name: 'text_stats',
    description:
      '统计一段文本的字符数和单词数。需要精确统计文本长度时调用;' +
      '不要自己心算,直接把原文传给这个工具。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要统计的完整文本,保持原文,不要截断。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          characters: {
            type: 'integer',
            description: 'Unicode 字符数(按 code point 计)。',
          },
          words: {
            type: 'integer',
            description: '按空白切分的单词数。',
          },
        },
        required: ['characters', 'words'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `字符数:${value.characters};单词数:${value.words}`,
        },
      ],
    },
    async execute(args) {
      if (typeof args.text !== 'string') {
        throw new Error('text 必须是字符串')
      }
      const text = args.text
      const words = text.trim() ? text.trim().split(/\s+/).length : 0
      return {
        characters: [...text].length,
        words,
      }
    },
  })

  ctx.tools.register({
    name: 'guarded_echo',
    description:
      '人工审批示例工具:执行前会请求用户批准。' +
      '需要演示 human-in-the-loop,或执行敏感操作前请求确认时调用。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '审批通过后原样返回的文本。',
        },
        reason: {
          type: 'string',
          description: '向用户解释为什么需要审批。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (typeof args.text !== 'string') {
        throw new Error('text 必须是字符串')
      }
      if (!exec.agent) {
        throw new Error('guarded_echo requires an owning agent session')
      }
      const outcome = await ctx.approval.request({
        agent: exec.agent,
        toolName: 'guarded_echo',
        callId: exec.callId,
        reason:
          typeof args.reason === 'string'
            ? args.reason
            : 'guarded_echo 请求人工确认',
        signal: exec.signal,
      })
      if (outcome !== 'allowed-once') {
        throw new Error(`人工审批未通过:${outcome}`)
      }
      return `已批准:${args.text}`
    },
  })
}
