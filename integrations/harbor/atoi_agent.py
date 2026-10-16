"""Harbor 0.24.0 BaseAgent adapter; the whole swarm runs in main.

Harbor owns sandbox provisioning, provider credentials, timeouts and cleanup.
No Harbor imports or vendor SDK calls are needed in the TypeScript harness.
"""

import json
import os
import tempfile
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class AtoiSwarm(BaseAgent):
    def __init__(self, *, bundle_path: str, config_path: str, **kwargs):
        self.bundle_path = Path(bundle_path).resolve(strict=True)
        self.template = json.loads(Path(config_path).read_text())
        super().__init__(**kwargs)

    @staticmethod
    def name() -> str:
        return "atoi-swarm"

    def version(self) -> str:
        return "filesystem-peers-v1"

    async def setup(self, environment: BaseEnvironment) -> None:
        # Task images provide Node 24+. Keep package installation independent of
        # Atlas, Temporal and Modal; install exactly the runtime dependencies.
        check = await environment.exec(
            "node -e 'if(Number(process.versions.node.split(\".\")[0])<24)process.exit(1)'"
            " && mkdir -p /tmp/atoi-harness",
            timeout_sec=30,
        )
        if check.return_code:
            raise RuntimeError(
                "Atoi requires a Linux task environment with Node.js 24+"
            )
        await environment.upload_file(self.bundle_path, "/tmp/atoi-harness/swarm.mjs")
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "package.json"
            package.write_text(
                json.dumps(
                    {
                        "private": True,
                        "type": "module",
                        "dependencies": {
                            "@earendil-works/pi-coding-agent": "1.1.0",
                            "@sinclair/typebox": "0.34.52",
                            "zod": "4.6.6",
                        },
                    }
                )
            )
            await environment.upload_file(package, "/tmp/atoi-harness/package.json")
        install = await environment.exec(
            "npm install --prefix /tmp/atoi-harness --omit=dev --no-audit --no-fund",
            timeout_sec=240,
        )
        if install.return_code:
            raise RuntimeError(f"Atoi dependency installation failed: {install.stderr}")

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        config = json.loads(json.dumps(self.template))
        config["objective"] = instruction
        if self.model_name:
            if "/" not in self.model_name:
                raise ValueError("Use a Pi catalog provider/model identifier")
            provider, model = self.model_name.split("/", 1)
            for agent in config["agents"]:
                agent.update(provider=provider, model=model)
        # Collect sessions, inboxes, results and usage with Harbor's trial logs.
        logs_root = str(self.environment_logs_dir / "atoi")
        config["controlRoot"] = f"{logs_root}/control"
        for environment_config in config["placement"]["environments"]:
            environment_config["stateRoot"] = f"{logs_root}/sessions"
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory) / "swarm.json"
            local.write_text(json.dumps(config))
            await environment.upload_file(local, "/tmp/atoi-harness/swarm.json")
        # Secret values travel through the environment API, never shell arguments.
        key = self._extra_env.get("ATOI_MODEL_API_KEY") or os.environ.get(
            "ATOI_MODEL_API_KEY"
        )
        env = {"ATOI_MODEL_API_KEY": key} if key else {}
        failure = None
        try:
            result = await environment.exec(
                "node /tmp/atoi-harness/swarm.mjs run /tmp/atoi-harness/swarm.json",
                env=env,
                timeout_sec=(config["limits"]["wallTimeMs"] + 999) // 1000 + 30,
            )
            if result.return_code:
                raise RuntimeError(
                    "Atoi did not reach quiescence; inspect atoi/control/*/state.json"
                )
        except BaseException as error:
            failure = error
            raise
        finally:
            try:
                await environment.download_dir(logs_root, self.logs_dir / "atoi")
                state_path = (
                    self.logs_dir
                    / "atoi/control"
                    / config["placement"]["runId"]
                    / "state.json"
                )
                state = json.loads(state_path.read_text())
                usages = [
                    turn["result"]["usage"]
                    for turn in state["turns"]
                    if "result" in turn
                ]
                context.n_input_tokens = sum(usage["input"] for usage in usages)
                context.n_output_tokens = sum(usage["output"] for usage in usages)
                context.n_cache_tokens = sum(usage.get("cache", 0) for usage in usages)
                context.cost_usd = sum(usage["cost"] for usage in usages)
                context.metadata = {
                    **(context.metadata or {}),
                    "swarm": {
                        "status": state["status"],
                        "turns": len(state["turns"]),
                        "messages": len(state["messages"]),
                        "usage_scope": "new native Pi usage entries in confirmed invocations, including cache and compaction; unconfirmed invocations may be missing",
                    },
                }
            except Exception:
                if failure is None:
                    raise
                self.logger.exception("Could not collect partial swarm evidence")
