# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in SolAgents programs, please report it responsibly.

**DO NOT** open a public GitHub issue for security vulnerabilities.

### Contact

- **Email:** darksol@agentmail.to
- **Subject line:** `[SECURITY] SolAgents — <brief description>`

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 5 business days
- **Fix timeline:** Depends on severity, but we aim for <14 days for critical issues

### Scope

The following are in scope:

- `bonding_curve` program (on-chain AMM, fee logic, graduation)
- `agentic_commerce` program (job escrow, state machine, fund flow)
- Any CPI interactions between programs

### Out of scope

- Frontend/API bugs (report separately)
- Already-known issues documented in GitHub issues
- Theoretical attacks with no practical exploit path

### Recognition

We appreciate responsible disclosure. Researchers who report valid vulnerabilities will be credited in our acknowledgments (unless they prefer anonymity).

## Upgrade Authority

Both programs are currently upgradeable (devnet). Before mainnet launch, upgrade authority governance will be documented here.
