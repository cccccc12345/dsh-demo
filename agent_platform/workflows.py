"""平台侧 agent 工作流名册与 prompt 上下文。

dsh runtime 的 ``list_agents`` 只列出**当前 agent 通过 subagent 工具启动的
continuable 子代理**,它不是"平台配置了哪些角色"的接口。平台工作流里的
各角色是并行的独立 runtime session,彼此不是父子关系,所以
``list_agents`` 返回空是正常的。

本模块负责:

- 定义平台可见的工作流名册(review 默认 coder + reviewer;pipeline 可自定义);
- 允许用仓库根目录的 ``workflows.json`` 覆盖角色、顺序和阶段指令;
- 为每个角色生成一段注入 prompt 的团队上下文,让模型能正确回答
  "有哪些 agent",并知道不要用 ``list_agents`` 判断团队规模。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_CODER_ID = "coder"
_REVIEWER_ID = "reviewer"
_SUPPORTED_IDS = frozenset({_CODER_ID, _REVIEWER_ID})

# review: 旧的 coder → reviewer 质量门禁;流水线模式按 agents 顺序逐段执行。
_KIND_REVIEW = "review"
_KIND_PIPELINE = "pipeline"
_SUPPORTED_KINDS = frozenset({_KIND_REVIEW, _KIND_PIPELINE})
_RESERVED_AGENT_IDS = frozenset({"assistant", "lead", "platform"})
_MAX_PIPELINE_AGENTS = 12
_AGENT_ID_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,31}")


@dataclass(frozen=True, slots=True)
class AgentSpec:
    """一个平台角色。``writes`` 只用于名册说明,不参与权限控制。"""

    id: str
    name: str
    emoji: str
    role: str
    writes: bool = False
    # 流水线模式下该角色的完整工作指令(仅后端 prompt 使用,不下发前端)。
    brief: str = ""
    # 该阶段约定写入工作区的产物(相对路径),用于交给下游并汇总。
    deliverable: str = ""

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
    """平台工作流的定义。

    - ``review``(默认):coder → reviewer →(可选)coder 修复 → reviewer 复审;
    - ``pipeline``:按 ``agents`` 顺序逐阶段执行,前一阶段产出作为后一阶段输入。

    流水线模式可自定义任意角色;review 模式仍只支持 coder / reviewer。
    """

    id: str
    name: str
    description: str
    agents: tuple[AgentSpec, ...]
    max_rounds: int = 1
    kind: str = _KIND_REVIEW

    @property
    def is_pipeline(self) -> bool:
        return self.kind == _KIND_PIPELINE

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
            "type": self.kind,
            "maxRounds": self.max_rounds,
            "agents": [agent.to_dict() for agent in self.agents],
        }

    def team_context(self, current_agent: str) -> str:
        """团队角色每轮看到的上下文;明确回答"有几个 agent"。"""
        rows: list[str] = []
        for index, agent in enumerate(self.agents, start=1):
            marker = "(你)" if agent.id == current_agent else ""
            if self.is_pipeline:
                deliverable = f" → `{agent.deliverable}`" if agent.deliverable else ""
                rows.append(
                    f"{index}. {agent.emoji} **{agent.name}** `{agent.id}`{marker}:"
                    f"{agent.role}{deliverable}"
                )
            else:
                rows.append(
                    f"- {agent.emoji} **{agent.name}** `{agent.id}`{marker}:{agent.role}"
                )
        rows.append(
            "- 🛠️ **Platform** `platform`:平台编排器(内部 lead 模型负责路由,"
            "不计入团队角色),负责在角色之间传递任务、汇报和审查意见。"
        )
        if self.is_pipeline:
            flow = " → ".join(f"`{agent.id}`" for agent in self.agents)
            header = (
                "[平台团队上下文]\n"
                f"当前工作流:`{self.id}`({self.name})。{self.description}\n"
                f"这是一个 {len(self.agents)} 阶段的顺序流水线:{flow}。"
                "平台会按顺序逐个执行,前一阶段的结论和产物文件会作为下一阶段的输入。\n"
                f"团队名册:共 {len(self.agents)} 个模型 agent + 1 个平台编排器。\n"
            )
            rules = (
                "\n\n说明:你只负责当前阶段,不要提前执行后续阶段,也不要重复上游已完成的工作。"
                "需要上游产物时优先读取工作区里的文件。"
                "`list_agents` 只列出你通过 `subagent`/`subagent_fork` 启动的 continuable "
                "子代理,不会列出上述平台角色;它返回空是正常的,不能用来判断团队人数。"
                "如果用户问「你能看到几个 agent」,请分两层回答:平台团队名册(上面列出的角色)"
                "与你自己已派生的 subagent(以 `list_agents` 为准,可能为空)。"
            )
            return header + "\n".join(rows) + rules
        header = (
            "[平台团队上下文]\n"
            f"当前工作流:`{self.id}`({self.name})。{self.description}\n"
            f"当前配置:reviewer 打回后,coder 最多修复 {self.max_rounds} 轮。\n"
            f"团队名册:共 {len(self.agents)} 个模型 agent + 1 个平台编排器。\n"
        )
        rules = (
            "\n\n说明:你只能看到自己的会话;其他角色的进展由平台在 prompt 中转述。"
            "`list_agents` 只列出你通过 `subagent`/`subagent_fork` 启动的 continuable "
            "子代理,不会列出上述平台角色;它返回空是正常的,不能用来判断团队人数。"
            "如果用户问「你能看到几个 agent」,请分两层回答:平台团队名册(上面列出的角色)"
            "与你自己已派生的 subagent(以 `list_agents` 为准,可能为空)。"
        )
        return header + "\n".join(rows) + rules

    def platform_context(self) -> str:
        """普通对话 agent 每轮看到的平台上下文。"""
        names = "、".join(f"`{agent.id}`({agent.name})" for agent in self.agents)
        return (
            "[平台上下文]\n"
            "你是平台默认对话 agent `assistant`。\n"
            f"平台注册了工作流 `{self.id}`({self.name}),包含 {len(self.agents)} "
            f"个模型 agent:{names}。该工作流只在用户勾选工作流模式时由平台编排;"
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


def _parse_pipeline_agents(raw_agents: Any) -> tuple[AgentSpec, ...]:
    """解析流水线角色列表,要求顺序、唯一 id 和完整角色描述。"""
    if not isinstance(raw_agents, list) or not raw_agents:
        raise ValueError("pipeline 工作流的 agents 必须是非空数组")
    if len(raw_agents) > _MAX_PIPELINE_AGENTS:
        raise ValueError(f"pipeline 最多支持 {_MAX_PIPELINE_AGENTS} 个阶段")
    parsed: list[AgentSpec] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_agents):
        if not isinstance(item, dict):
            raise ValueError("agents[] 必须是对象")
        agent_id = str(item.get("id") or "").strip()
        if not _AGENT_ID_PATTERN.fullmatch(agent_id):
            raise ValueError(
                f"agents[{index}].id 必须是 kebab-case(小写字母/数字/连字符):{agent_id!r}"
            )
        if agent_id in _RESERVED_AGENT_IDS:
            raise ValueError(f"agents[{index}].id 不能使用保留名 {agent_id!r}")
        if agent_id in seen:
            raise ValueError(f"agents[{index}].id 重复:{agent_id!r}")
        seen.add(agent_id)
        role = str(item.get("role") or "").strip()
        if not role:
            raise ValueError(f"agents[{index}].role 不能为空")
        writes = item.get("writes", False)
        if not isinstance(writes, bool):
            raise ValueError(f"agents[{agent_id}].writes 必须是布尔值")
        parsed.append(
            AgentSpec(
                id=agent_id,
                name=str(item.get("name") or agent_id),
                emoji=str(item.get("emoji") or "🤖"),
                role=role,
                writes=writes,
                brief=str(item.get("brief") or role),
                deliverable=str(item.get("deliverable") or ""),
            )
        )
    return tuple(parsed)


def _merge_workflow(raw: dict[str, Any], base: WorkflowSpec) -> WorkflowSpec:
    """在 ``base`` 上应用 ``workflows.json`` 的覆盖项。"""
    kind = str(raw.get("type") or base.kind).strip().lower()
    if kind not in _SUPPORTED_KINDS:
        raise ValueError(f"不支持的工作流类型 {kind!r};可选 review / pipeline")

    raw_rounds = raw.get("maxRounds", base.max_rounds)
    try:
        max_rounds = int(raw_rounds)
    except (TypeError, ValueError) as exc:
        raise ValueError("maxRounds 必须是整数") from exc
    if not 0 <= max_rounds <= 10:
        raise ValueError("maxRounds 必须在 0 到 10 之间")

    if kind == _KIND_PIPELINE:
        agents = _parse_pipeline_agents(raw.get("agents"))
    else:
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
                        f"不支持的角色 {agent_id!r};review 工作流只支持 coder / reviewer"
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
                    brief=str(item.get("brief") or current.brief),
                    deliverable=str(item.get("deliverable") or current.deliverable),
                )
        # 固定按 coder → reviewer 的顺序展示,避免自定义文件改变 UI 的心智模型。
        agents = tuple(
            agents_by_id[agent_id] for agent_id in (_CODER_ID, _REVIEWER_ID)
        )

    return WorkflowSpec(
        id=str(raw.get("id") or base.id),
        name=str(raw.get("name") or base.name),
        description=str(raw.get("description") or base.description),
        agents=agents,
        max_rounds=max_rounds,
        kind=kind,
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
