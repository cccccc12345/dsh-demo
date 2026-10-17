"""平台侧 agent 工作流名册与 prompt 上下文。

dsh runtime 的 ``list_agents`` 只列出**当前 agent 通过 subagent 工具启动的
continuable 子代理**,它不是"平台配置了哪些角色"的接口。平台团队模式里的
coder / reviewer 是并行的独立 runtime session,彼此不是父子关系,所以
``list_agents`` 返回空是正常的。

本模块负责:

- 定义平台可见的工作流名册(默认 coder + reviewer);
- 允许用仓库根目录的 ``workflows.json`` 覆盖角色名称/描述/最大修复轮数;
- 为每个角色生成一段注入 prompt 的团队上下文,让模型能正确回答
  "有哪些 agent",并知道不要用 ``list_agents`` 判断团队规模。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_CODER_ID = "coder"
_REVIEWER_ID = "reviewer"
_SUPPORTED_IDS = frozenset({_CODER_ID, _REVIEWER_ID})


@dataclass(frozen=True, slots=True)
class AgentSpec:
    """一个平台角色。``writes`` 只用于名册说明,不参与权限控制。"""

    id: str
    name: str
    emoji: str
    role: str
    writes: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "emoji": self.emoji,
            "role": self.role,
            "writes": self.writes,
        }


@dataclass(frozen=True, slots=True)
class WorkflowSpec:
    """团队模式的工作流定义。

    当前平台编排器固定执行 coder → reviewer →(可选)coder 修复 → reviewer
    复审,所以 ``agents`` 只支持 coder / reviewer 两个角色;可自定义的是展示
    名称、职责描述和最大修复轮数。
    """

    id: str
    name: str
    description: str
    agents: tuple[AgentSpec, ...]
    max_rounds: int = 1

    def agent(self, agent_id: str) -> AgentSpec:
        for agent in self.agents:
            if agent.id == agent_id:
                return agent
        raise KeyError(f"未知角色: {agent_id}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "maxRounds": self.max_rounds,
            "agents": [agent.to_dict() for agent in self.agents],
        }

    def team_context(self, current_agent: str) -> str:
        """团队角色每轮看到的上下文;明确回答"有几个 agent"。"""
        rows: list[str] = []
        for agent in self.agents:
            marker = "(你)" if agent.id == current_agent else ""
            rows.append(f"- {agent.emoji} **{agent.name}** `{agent.id}`{marker}:{agent.role}")
        rows.append(
            "- 🛠️ **Platform** `platform`:平台编排器(内部 lead 模型负责路由,"
            "不计入团队角色),负责在角色之间传递任务、汇报和审查意见。"
        )
        return (
            "[平台团队上下文]\n"
            f"当前工作流:`{self.id}`({self.name})。{self.description}\n"
            f"当前配置:reviewer 打回后,coder 最多修复 {self.max_rounds} 轮。\n"
            f"团队名册:共 {len(self.agents)} 个模型 agent + 1 个平台编排器。\n"
            + "\n".join(rows)
            + "\n\n"
            "说明:你只能看到自己的会话;其他角色的进展由平台在 prompt 中转述。"
            "`list_agents` 只列出你通过 `subagent`/`subagent_fork` 启动的 continuable "
            "子代理,不会列出上述平台角色;它返回空是正常的,不能用来判断团队人数。"
            "如果用户问「你能看到几个 agent」,请分两层回答:平台团队名册(上面列出的角色)"
            "与你自己已派生的 subagent(以 `list_agents` 为准,可能为空)。"
        )

    def platform_context(self) -> str:
        """普通对话 agent 每轮看到的平台上下文。"""
        names = "、".join(f"`{agent.id}`({agent.name})" for agent in self.agents)
        return (
            "[平台上下文]\n"
            "你是平台默认对话 agent `assistant`。\n"
            f"平台注册了团队工作流 `{self.id}`({self.name}),包含 {len(self.agents)} "
            f"个模型 agent:{names}。该工作流只在用户勾选团队模式时由平台编排;"
            "普通对话中它们不是你的子代理,你无法通过 `send_message` 直接调用它们。\n"
            "`list_agents` 只列出你通过 `subagent`/`subagent_fork` 启动的 continuable "
            "子代理,不是平台 agent 清单;它返回空不代表平台没有其他角色。"
            "如果用户问「你能看到几个 agent」,请分两层回答:平台名册"
            "(assistant + 上述团队角色)与你自己已派生的 subagent(以 `list_agents` 为准)。"
        )


def default_workflow() -> WorkflowSpec:
    return WorkflowSpec(
        id="coder-reviewer",
        name="Coder + Reviewer",
        description=(
            "平台编排:coder 实现,reviewer 审查;reviewer 打回时 coder 修复一轮后复审。"
        ),
        agents=(
            AgentSpec(
                id=_CODER_ID,
                name="Coder",
                emoji="👨‍💻",
                role="实现工程师,在工作区写代码与测试,完成后汇报改动文件与验证方式",
                writes=True,
            ),
            AgentSpec(
                id=_REVIEWER_ID,
                name="Reviewer",
                emoji="🔍",
                role="代码审查员,只读审查并输出「结论:APPROVE」或「结论:NEEDS_CHANGES」",
            ),
        ),
        max_rounds=1,
    )


def _merge_workflow(raw: dict[str, Any], base: WorkflowSpec) -> WorkflowSpec:
    """在 ``base`` 上应用 ``workflows.json`` 的覆盖项。"""
    agents_by_id = {agent.id: agent for agent in base.agents}

    raw_agents = raw.get("agents")
    if raw_agents is not None:
        if not isinstance(raw_agents, list):
            raise ValueError("agents 必须是数组")
        for item in raw_agents:
            if not isinstance(item, dict):
                raise ValueError("agents[] 必须是对象")
            agent_id = item.get("id")
            if agent_id not in _SUPPORTED_IDS:
                raise ValueError(
                    f"不支持的角色 {agent_id!r};当前平台编排只支持 coder / reviewer"
                )
            current = agents_by_id[agent_id]
            writes = item.get("writes", current.writes)
            if not isinstance(writes, bool):
                raise ValueError(f"agents[{agent_id}].writes 必须是布尔值")
            agents_by_id[agent_id] = AgentSpec(
                id=agent_id,
                name=str(item.get("name") or current.name),
                emoji=str(item.get("emoji") or current.emoji),
                role=str(item.get("role") or current.role),
                writes=writes,
            )

    raw_rounds = raw.get("maxRounds", base.max_rounds)
    try:
        max_rounds = int(raw_rounds)
    except (TypeError, ValueError) as exc:
        raise ValueError("maxRounds 必须是整数") from exc
    if not 0 <= max_rounds <= 10:
        raise ValueError("maxRounds 必须在 0 到 10 之间")

    # 固定按 coder → reviewer 的顺序展示,避免自定义文件改变 UI 的心智模型。
    ordered_agents = tuple(agents_by_id[agent_id] for agent_id in (_CODER_ID, _REVIEWER_ID))
    return WorkflowSpec(
        id=str(raw.get("id") or base.id),
        name=str(raw.get("name") or base.name),
        description=str(raw.get("description") or base.description),
        agents=ordered_agents,
        max_rounds=max_rounds,
    )


def load_workflow(path: Path | None) -> WorkflowSpec:
    """读取工作流配置;缺失或非法时回退到默认名册并打印警告。"""
    base = default_workflow()
    if path is None or not path.is_file():
        return base
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("顶层必须是 JSON 对象")
        # 允许 {"workflow": {...}} 包装,方便以后放多个工作流。
        if isinstance(raw.get("workflow"), dict):
            raw = raw["workflow"]
        workflow = _merge_workflow(raw, base)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        print(f"[agent-platform] 工作流配置无效,使用默认名册({path}):{exc}")
        return base
    print(f"[agent-platform] 已加载 agent 工作流名册:{path}({workflow.id})")
    return workflow
