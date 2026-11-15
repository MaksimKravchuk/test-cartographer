# Security policy

Test Cartographer stores role credentials in workspace files, runs AI agents against live applications, and runs a local API and MCP servers. Security reports are taken seriously.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**.

Include what is affected, how to reproduce it, and what an attacker could do with it. You'll get a reply within a week.

## Scope

Examples of what we want to hear about:

- a secret field's value reaching an agent, a log, evidence or a proposal file;
- the engine calling an MCP tool that isn't in `mcp.*.allow`;
- the local API or the agent bridge being reachable from other machines or other websites;
- generated tests or the action library running code the user didn't write or approve.

Only the latest commit on `main` is supported for now.
