---
status: accepted
---

# Separate launch and session permissions

Launch-time `permission_mode` configures how acpx starts an agent, while the direct ACP runtime's permission-request policy resolves typed in-session options by semantic kind or stable option ID. These controls remain separate because launcher defaults and protocol-time authorization occur at different trust boundaries and cannot safely be inferred from one another.
