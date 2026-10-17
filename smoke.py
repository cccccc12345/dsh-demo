"""Smoke test: run one minimal agent turn and dump the event vocabulary."""
import json
from pathlib import Path

from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig


def load_env(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ").strip()
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip().strip('"').strip("'")
    return values


def main() -> None:
    env = load_env(".env")
    root = Path(__file__).resolve().parent
    home = str(root / ".dsh-home")
    workspace = str(root / ".dsh-workspace")

    harness = DeepSeekHarness(
        DeepSeekHarnessConfig(
            cwd=workspace,
            dsh_home=home,
            api_key=env.get("DEEPSEEK_API_KEY"),
        )
    )
    harness.start()
    try:
        result = harness.run("Reply with exactly: pong")
        print("=== RunResult ===")
        print("session_id:", result.session_id)
        print("finish_reason:", result.finish_reason)
        print("final_response:", result.final_response[:200])
        print("=== notification methods ===")
        for n in result.notifications:
            keys = ",".join(sorted(n.payload.keys()))
            print(f"  {n.method}  ({keys})")
        print("=== session event types ===")
        seen = {}
        for event in result.events:
            etype = event.get("type")
            data = event.get("data") if isinstance(event.get("data"), dict) else {}
            if etype not in seen:
                seen[etype] = json.dumps({k: data.get(k) for k in list(data)[:4]}, default=str)[:300]
        for etype, sample in seen.items():
            print(f"  {etype}  sample={sample}")
    finally:
        harness.close()


if __name__ == "__main__":
    main()
