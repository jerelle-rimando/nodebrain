# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ Active |

Only the latest release receives security updates. Older versions are not patched.

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub Issues.**

If you discover a security vulnerability in NodeBrain, report it privately through one of these channels:

- **GitHub Private Vulnerability Reporting** — go to the Security tab of this repo and click "Report a vulnerability"
- **Email** — send details to the maintainer directly via GitHub profile contact

### What to include in your report

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes if you have them

### What to expect

- Acknowledgment within 48 hours
- Status update within 7 days
- Credit in the release notes if you want it

---

## Scope

The following are considered in scope for security reports:

- Credential vault encryption weaknesses
- Authentication or authorization bypasses
- Remote code execution via agent task input
- MCP server sandbox escapes
- API key exposure through logs or responses
- Path traversal in the filesystem integration

The following are out of scope:

- Vulnerabilities in third party MCP server packages
- Issues requiring physical access to the machine
- Social engineering attacks
- Vulnerabilities in AI model providers themselves

---

## Security Architecture

NodeBrain is a local-first application. Understanding the security model helps contextualize reports:

- All credentials are encrypted with AES-256 before storage
- `VAULT_SECRET` is auto-generated with 32 cryptographically random bytes on first run
- The backend only accepts connections from `http://localhost:5173` via CORS
- No data is transmitted to external servers except explicit API calls made by agents
- The filesystem integration is sandboxed to a user-defined path enforced by the MCP server

---

## Known Limitations

These are known security considerations that are accepted for v0.1 and will be addressed in future versions:

- Agent task prompts are not sanitized — prompt injection is theoretically possible in multi-user or networked deployments. In the default localhost-only configuration this is low risk since only the local user sends input.
- No rate limiting on the local API
- The filesystem integration path is user-controlled — misconfiguration can expose sensitive directories
- MCP server packages are third party and their security is not audited by NodeBrain maintainers

---

## Disclaimer

NodeBrain is provided as-is with no warranty. The maintainers are not liable for damages arising from security vulnerabilities, misconfigurations, or unintended agent behavior. Users are responsible for their own deployment and configuration.
