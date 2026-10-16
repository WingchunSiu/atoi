"""Contract checks against installed Harbor; no container or inference claims."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from harbor.agents.factory import AgentFactory
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

from integrations.harbor.atoi_agent import AtoiSwarm


class AdapterTest(unittest.IsolatedAsyncioTestCase):
    async def test_framework_import_and_adapter_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = root / "swarm.mjs"
            bundle.write_text("// fixture; not executed in this contract test")
            template = Path("examples/swarm/harbor.json").resolve()
            agent = AgentFactory.create_agent_from_import_path(
                "integrations.harbor.atoi_agent:AtoiSwarm",
                logs_dir=root / "logs",
                model_name="openai/gpt-4.1",
                bundle_path=str(bundle),
                config_path=str(template),
            )
            self.assertIsInstance(agent, AtoiSwarm)
            environment = AsyncMock(spec=BaseEnvironment)
            environment.exec.return_value = ExecResult(return_code=0)
            uploads = {}

            async def upload(source, destination):
                uploads[destination] = Path(source).read_text()

            environment.upload_file.side_effect = upload
            await agent.setup(environment)
            package = json.loads(uploads["/tmp/atoi-harness/package.json"])
            self.assertEqual(
                package["dependencies"]["@earendil-works/pi-coding-agent"], "1.1.0"
            )

            async def download(source, destination):
                state = Path(destination) / "control/team/state.json"
                state.parent.mkdir(parents=True, exist_ok=True)
                state.write_text(
                    json.dumps(
                        {
                            "status": "quiescent",
                            "messages": [{}, {}],
                            "turns": [
                                {
                                    "result": {
                                        "usage": {
                                            "input": 30,
                                            "cache": 5,
                                            "output": 10,
                                            "cost": 0.01,
                                        }
                                    }
                                },
                                {
                                    "result": {
                                        "usage": {
                                            "input": 20,
                                            "cache": 3,
                                            "output": 5,
                                            "cost": 0.02,
                                        }
                                    }
                                },
                            ],
                        }
                    )
                )

            environment.download_dir.side_effect = download
            context = AgentContext()
            with patch.dict(
                "os.environ", {"ATOI_MODEL_API_KEY": "fixture-secret-not-a-real-key"}
            ):
                await agent.run("The actual task instruction", environment, context)
            actual_config = json.loads(uploads["/tmp/atoi-harness/swarm.json"])
            self.assertEqual(actual_config["objective"], "The actual task instruction")
            self.assertEqual(context.n_input_tokens, 50)
            self.assertEqual(context.n_cache_tokens, 8)
            self.assertEqual(context.n_output_tokens, 15)
            self.assertEqual(context.cost_usd, 0.03)
            command = environment.exec.call_args
            self.assertNotIn("fixture-secret", command.args[0])
            self.assertEqual(
                command.kwargs["env"]["ATOI_MODEL_API_KEY"],
                "fixture-secret-not-a-real-key",
            )
            self.assertFalse(agent.capabilities.atif)

            # Failure still collects partial usage/evidence; it is never a score.
            environment.exec.return_value = ExecResult(return_code=1)
            context = AgentContext()
            with self.assertRaisesRegex(RuntimeError, "did not reach quiescence"):
                await agent.run("Task", environment, context)
            self.assertEqual(context.n_input_tokens, 50)

    async def test_setup_rejects_an_unsupported_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / "swarm.mjs"
            bundle.write_text("")
            agent = AtoiSwarm(
                logs_dir=Path(directory),
                bundle_path=str(bundle),
                config_path="examples/swarm/harbor.json",
            )
            environment = AsyncMock(spec=BaseEnvironment)
            environment.exec.return_value = ExecResult(return_code=1)
            with self.assertRaisesRegex(RuntimeError, "Node.js 24"):
                await agent.setup(environment)
            environment.upload_file.assert_not_called()


if __name__ == "__main__":
    unittest.main()
