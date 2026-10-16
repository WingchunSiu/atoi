# Evaluate a whole swarm with Harbor

This adapter targets **Harbor 0.24.0**. `AtoiSwarm` implements Harbor's `BaseAgent`
and launches the TypeScript swarm inside Harbor's task environment. Harbor owns
the environment, vendor credentials, outer trial timeout, verifier and cleanup.
The core neither imports Harbor nor calls Modal/Daytona APIs.

The current adapter uses `BaseAgent` to upload and launch the swarm CLI manually.
Its model/tool loops still run inside the task environment. This is not an
external-loop deployment; `BaseInstalledAgent` is the official preferred base
class for this placement and remains an integration cleanup step.

Harbor already provides [sandbox adapters](https://docs.harborframework.com/sandboxes/pre-integrated-sandboxes)
and a [custom-agent interface](https://docs.harborframework.com/agents/custom-agents).
Reusing their environment lifecycle is preferable to copying provider SDK code.
Its built-in Pi agent runs a Pi agent; it does not automatically supply atoi's
peer inboxes or swarm scheduler. Several entries in Harbor's `agents` job config
are separate trial participants/configurations, not a collaborating swarm.

## Run

From the repository root, with Node 24+, pnpm, uv and a running Docker daemon:

```sh
pnpm install --frozen-lockfile
pnpm build
uv venv .cache/harbor-venv
uv pip install --python .cache/harbor-venv/bin/python -r integrations/harbor/requirements.txt
export ATOI_MODEL_API_KEY=... # use an environment secret, not an --agent-env value
PYTHONPATH=. .cache/harbor-venv/bin/harbor run \
  --path examples/harbor/swarm-smoke \
  --agent integrations.harbor.atoi_agent:AtoiSwarm \
  --agent-kwarg bundle_path=dist/guest/swarm.mjs \
  --agent-kwarg config_path=examples/swarm/harbor.json \
  --model openai/gpt-4.1 \
  --env docker
```

The task image must provide Linux and Node 24+ and allow installation of the
pinned Pi/runtime dependencies during setup. The smoke task uses
`node:24-bookworm`. Other tasks need the same prerequisite; this adapter does not
silently mutate arbitrary task images to install Node. Bundle sources are local
host files uploaded through `BaseEnvironment`; no public package publication is
needed. Only direct Pi catalog model identifiers and `ATOI_MODEL_API_KEY` are
supported here; custom endpoints, Harbor model gateways, MCP, skills injection,
trajectory resume and hosted-Hub execution have not been integrated.

Change the Harbor environment option and install the corresponding Harbor extra
to try another provider, subject to its capabilities, image/network support and
credentials. Docker, Modal and Daytona are **not** all validated by these checks.
There is no atoi-owned vendor adapter or provider fallback that silently changes
isolation semantics.

## Evaluation boundary

One Harbor trial runs one whole team. The current adapter uses one `main`
environment for the controller and all peer Pi sessions. Agents may share the
task directory or use prepared separate directories/worktrees. Independent
containers per peer are not implemented. Harbor's
[multi-container support](https://docs.harborframework.com/tasks/multi-container)
provides `main` plus task sidecars; it does not automatically create an agent
runtime per service. Multi-container support also varies by provider.

The config's objective is replaced by the actual task instruction. Passing
`--model` selects one model for all configured peers; omit it to retain per-agent
models in the config. Role instructions, communication mode, workspaces and
limits otherwise come from `config_path`. Keep shared-task artifact paths where
the task verifier expects them, usually `/app`. No automatic Git merge or artifact
copy-back from private workspaces is performed.

The adapter collects native Pi sessions, invocation results and the causal inbox
ledger under Harbor's agent logs (`atoi/`). It populates aggregate input/output,
cache-token and reported-cost fields from confirmed invocation results. Native
compaction usage is included; restored session history is not counted twice.
Interrupted invocations without confirmed usage can be missing. In that case
reported totals are incomplete, not evidence of low cost. Per-agent ATIF export
is not implemented and the adapter does not advertise ATIF support.

Harbor's task verifier supplies the task reward after agent execution. Swarm
quiescence is only a scheduler state. The included task's deterministic verifier
checks the JSON result and the presence of a review artifact. It is a wiring
smoke check: it does not prove review quality, necessary collaboration, resistance
to agent tampering, or benchmark validity. Native traces and message causality
are available for a future independent collaboration evaluator.

Pi sessions, shell commands and the controller currently share the environment's
permissions. A task's adversarial-isolation claims require an additional enforced
boundary, including an independent verifier environment where appropriate.
The same filesystem store must not be mounted as a multi-writer control database.

## Checks and current verification status

```sh
.cache/harbor-venv/bin/python -m unittest integrations.harbor.test_adapter -v
```

These checks import and instantiate the adapter using **real Harbor 0.24.0**
and its agent factory, with a mocked `BaseEnvironment`. They verify setup calls,
pinned dependencies, task/model mapping, secret transport, usage aggregation,
failure evidence collection and unsupported-runtime rejection. The example task
also parses successfully through Harbor's `Task` model.

The TypeScript swarm tests separately execute real Pi tool loops and filesystem
effects with scripted model responses. A real Docker/provider trial and real
inference were not run in this development environment: the Docker daemon was
unavailable and no `ATOI_MODEL_API_KEY` was configured. These contract checks are
not an end-to-end Harbor result or a verified reward.
