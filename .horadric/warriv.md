# Warriv's memory

## Rules

- Anything that signs in with the human's own account or creates real prod data (workspaces, sends) goes to the human, never a session.
- A test that needs the human's admin login or their local Claude/MCP config is the human's to run; a session can only verify what it can reach in the browser without their accounts.

## Lately

- 2026-10-12 "Test AgentID sign-up end to end from an MCP client" came back half done (browser AgentID sign-up verified, acc_fgfx40nc714xcpa6ydt5). Left the remaining two checks with the human: admin badge and the MCP OAuth path.
- 2026-10-12 Handed "Test AgentID sign-up end to end from an MCP client" to the human: needs their AgentID login and makes a real prod workspace.

## Open

- "Test AgentID sign-up end to end from an MCP client": waiting on the human for 1) /admin/accounts/acc_fgfx40nc714xcpa6ydt5 Agent sign-up badge + owner email, 2) MCP OAuth path (claude mcp remove day3 -s local, re-add without the key header, /mcp, run day3_context). When answered, mark it done or file a fix quest for whichever check failed.
