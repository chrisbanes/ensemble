---
status: accepted
---

# Model pipelines as step DAGs with strict outputs

Pipelines are configured as named steps that run sequentially by default and use explicit dependencies for roots or parallel branches. Agents report a strict `StepOutput` through a separate extraction turn, allowing the pipeline—not agent prose—to apply success, failure, concern, retry, and downstream-output policy at step boundaries; approval requests are separate durable artifacts.
