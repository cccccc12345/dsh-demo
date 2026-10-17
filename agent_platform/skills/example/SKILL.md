---
name: example
description: 平台示例 skill,用于验证自定义 skill 目录已生效,并演示 SKILL.md 的 frontmatter 与正文格式。
whenToUse: 当用户询问平台是否支持 skill,或要求演示 skill 加载时使用。
---

# Example Skill

这是一个示例 skill。它可以通过模型侧的 `skill` 工具加载,也可以由用户在消息中输入 `/example` 直接调用。

## 格式说明

- 目录式 skill:`agent_platform/skills/<name>/SKILL.md`
- 扁平 skill:`agent_platform/skills/<name>.md`
- frontmatter 必填 `name`(kebab-case)和 `description`;
  可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。

## 使用建议

- 仅在用户明确要求演示 skill 时使用。
- 不要把本示例当成真实业务能力;替换成团队自己的技能说明即可。
