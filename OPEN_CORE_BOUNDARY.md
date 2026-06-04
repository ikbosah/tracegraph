# TraceGraph — Open-Core Boundary

TraceGraph is an **open-core** product. The core runtime and analysis engine are
MIT-licensed. Enterprise features require a commercial license.

---

## MIT-Licensed (Open Source)

| Package / Feature | Location |
|---|---|
| Trace runtime — JavaScript/TypeScript | `packages/trace-js` |
| Trace runtime — PHP/Laravel | `packages/trace-php` |
| Trace runtime — Java/Spring Boot | `packages/trace-java` *(M11)* |
| Trace runtime — Python/FastAPI | `packages/trace-python` *(M12)* |
| Trace runtime — .NET/ASP.NET Core | `packages/trace-dotnet` *(M13)* |
| Trace runtime — Go/Gin | `packages/trace-go` *(M14)* |
| Trace runtime — Kotlin/Ktor | `packages/trace-kotlin` *(M15)* |
| Graph engine + diff engine | `packages/graph-engine` |
| Security & reliability findings | `packages/graph-engine/src/findings.ts` |
| Scenario runner + TraceBundle | `packages/scenario-runner` |
| CLI — all open commands | `packages/cli` |
| VS Code extension | `apps/vscode-extension` |
| Eclipse plugin | `apps/eclipse-plugin` *(M16)* |
| OTel import/export | `packages/otel-bridge` *(M17)* |
| HTML viewer / webview | `apps/webview` |
| CI reporter | `packages/ci-reporter` |
| GitHub Action | `.github/tracegraph-action/` |

---

## Enterprise Edition (requires a license)

Enterprise features live in the `ee/` directory.

| Feature | Milestone |
|---|---|
| Team Server — shared dashboard, baselines, approvals | M9A |
| GitHub App — PR comments, status checks, inline annotations | M9B |
| ProdReady Evidence Pack — Go/Conditional Go/No-Go decision | M9D |
| Runtime Contract Engine — baseline-to-contract promotion | M9C |
| Repair Packet Generator — structured AI fix instructions | M9E |
| CDC Evidence Engine — database mutation attribution | M18 |
| AI Finding Triage — LLM-assisted verdict suggestions | IMP-6 |
| HTTP Test Generation — auto-generate tests from traces | IMP-6 |
| Continuous Baseline Learning — green-run auto-update | IMP-6 |
| Try Pro Mode — 30-day per-project trial | IMP-7 |

---

## Usage Analytics

TraceGraph **never** collects analytics without your explicit opt-in.

When you run `tracegraph init`, you will be asked once whether you want to
share anonymous usage data. The default answer is **No**.

What is collected when opted in:
- Command names and counts (e.g. `command.compare`)
- A random UUID per machine (no PII, not linked to your identity)
- CLI version, Node.js version, OS platform
- Capture level and finding counts per compare run

What is **never** collected:
- File paths, function names, class names
- Trace content, report content, baseline content
- User email, git author, or any personal information

To opt out at any time: set `analytics.optIn: false` in `.tracegraph/config.json`
or set the environment variable `TRACEGRAPH_NO_ANALYTICS=1`.

---

## License

The open-source components are licensed under the [MIT License](LICENSE).

For Enterprise licensing, contact **sales@tracegraph.io** or visit
**https://tracegraph.io/pricing**.
