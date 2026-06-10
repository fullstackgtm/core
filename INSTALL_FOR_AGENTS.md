# Installing fullstackgtm (for AI agents)

Deterministic install-and-verify steps. Every command is non-interactive, every
check has an expected output, and nothing here writes to a CRM.

## 1. Install

```bash
npm install -g fullstackgtm
# or project-local: npm install fullstackgtm
# or zero-install: prefix the commands below with `npx`
```

Requires Node >= 20. No other runtime dependencies.

## 2. Verify

```bash
fullstackgtm doctor --json
```

Expect a JSON object with `node.ok: true` and `package.version` set. The
`providers` map shows `"source": "none"` for every provider on a fresh
machine — that is normal and does not block the next step.

## 3. First value, zero credentials

```bash
fullstackgtm audit --demo --json
```

Expect a JSON patch plan with `dryRun: true` and ~80 findings over a generated,
deliberately messy CRM. Deterministic per seed: `--seed 7` is the default, so
two runs produce identical finding and operation ids. Exit code 0.

This proves the whole pipeline (snapshot → audit → plan) without any account.

## 4. Connect a real provider (requires a human or stored credentials)

Credential resolution ladder, first match wins:

1. `--token-env <NAME>` — explicit env var for one invocation
2. Ambient env: `HUBSPOT_ACCESS_TOKEN`, or `SALESFORCE_ACCESS_TOKEN` + `SALESFORCE_INSTANCE_URL`, or `STRIPE_SECRET_KEY`
3. Stored login: `fullstackgtm login <provider>` (interactive; a human runs this once)
4. Broker pairing: `fullstackgtm login --via <hosted url>` (a human approves the pairing code)

In an agent sandbox, prefer rung 1 or 2. Never echo tokens into argv —
`login` reads secrets from stdin only.

```bash
HUBSPOT_ACCESS_TOKEN=$TOKEN fullstackgtm audit --provider hubspot --json --out plan.json
```

Exit codes everywhere: `0` success, `1` error, `2` findings at/above `--fail-on`.

## 5. Writes are approval-gated — by design

`audit` never mutates anything. `apply` writes only operation ids explicitly
passed via `--approve`, and refuses `requires_human_*` placeholder values
unless a concrete `--value <opId>=<v>` override is supplied. Do not attempt to
bypass this; surface the plan to a human instead:

```bash
fullstackgtm audit --provider hubspot --save     # persists plan to ~/.fullstackgtm/plans
fullstackgtm plans list                          # a human reviews and approves
```

## 6. MCP server (optional)

The MCP entrypoint needs optional peers that plain `npx fullstackgtm-mcp`
does not install:

```bash
npx -p fullstackgtm -p @modelcontextprotocol/sdk -p zod fullstackgtm-mcp
```

Tools exposed over stdio: `fullstackgtm_audit` (read-only),
`fullstackgtm_rules`, `fullstackgtm_apply` (requires `approvedOperationIds`).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `fullstackgtm: command not found` | Re-run with `npx fullstackgtm`, or check global npm bin is on PATH |
| `No HubSpot credentials` (exit 1) | Set `HUBSPOT_ACCESS_TOKEN` or have a human run `fullstackgtm login hubspot` |
| MCP server prints peer-dependency help | Install `@modelcontextprotocol/sdk` and `zod` (see step 6) |
| Need machine state for orchestration | `fullstackgtm doctor --json` |
