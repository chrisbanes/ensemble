---
status: accepted
---

# Add static route steps to pipelines

Pipelines retain their declared acyclic DAG. A route is an agentless node that selects exactly one
partition of direct successors from a required string enum in a direct producer's schema-validated
output. The selection and source-output digest are durable run evidence, while inactive work is
recorded as `Skipped` rather than fabricated as agent success.

This avoids dynamic graph mutation and general conditional expressions: activation can prove the
complete topology before work begins, recovery does not re-evaluate an earlier selection, and
shared joins retain ordinary dependency semantics. Dynamic loops, predicates, coercion, defaults,
provider routing, and routing from unvalidated text remain out of scope.
