# Threat Model — Cash Pop (v14)

Scope: the EJS fullstack app (player site + admin panel + webhooks + cron).
Out of scope: the payment providers themselves, the hosting platform, and any
external pen-test (see "Residual risks" — that needs outside testers).

## Assets
- Player wallets (real money balances) and the append-only ledger.
- Draw seeds (pre-settle secrecy = draw integrity) and scratch commitments.
- Gateway credentials (provider API keys / webhook secrets).
- Admin sessions and staff accounts (money actions).
- Player PII: email, phone, payout details.

## Trust boundaries
- Public internet → player site (authenticated sessions, CSRF, rate limits).
- Providers → /webhooks/* (HMAC signature, raw body, event dedup).
- Staff → admin panel (stealth path, role-based actions, audit hash-chain).
- Cron → in-process jobs (draw settle, reconciliation, expiry).

## Threats and mitigations (v14 state)
| Threat | Mitigation |
|---|---|
| Draw rigging by operator/insider | Commit-reveal (seed_hash at creation, seed revealed only after settle) + public drand beacon combined at settle + rejection sampling (no modulo bias). Pre-v14 draws have no beacon (legacy derivation, documented on /fairness). Residual: a DB insider who reads `draws.seed` before settle could pre-compute the outcome — the beacon makes the outcome depend on public randomness the insider cannot predict, but seed secrecy still matters. |
| Free money via deposit auto-approve | Removed in v13. Credit happens only via verified webhook or admin approval against a statement entry. |
| Webhook forgery | Real HMAC-SHA256 + timingSafeEqual against every enabled method's secret on the rail; fail closed; event_id dedup; refund/chargeback revokes. |
| Double-spend / race | Guarded `UPDATE ... balance + ? >= 0` + affected-row check in postLedger and agent float transfer. |
| OTP account takeover | No demo codes in any response; crypto codes; per-identifier caps; OTP login refuses staff/banned/pending/TOTP accounts; withdrawal OTP fails closed when undeliverable. |
| Withdrawal abuse | Turnover ≥1×, daily/monthly caps, payout-detail change lock (24–72h, locks ALL withdrawals in the window), same-method preference, maker-checker above threshold, provider payout ID required to mark paid. |
| Unverified-contact abuse | Verified-contact gate (email OR phone) before deposit/withdraw; staff attestation is audited. No KYC by operator policy. |
| Referral farming | Credits are pending until referee's first approved deposit + wagering; per-referee cap; release is a ledger post. |
| Shared-device multi-accounts | Flags only (device/IP overlap), never auto-ban; staff review page. |
| Credential theft from DB | AES-256-GCM at rest (env key); without the env key, credential saves are REFUSED (fail closed, v16) — no plaintext fallback for new credentials. Plaintext legacy rows stay readable until re-saved; unreadable rows show a warning, never crash. (Row updated 2026-10-27, v17 round 2b.) |
| Admin account takeover | Stealth path (non-admin → plain 404 + audit probe); RBAC (finance/support/risk/super, fail-closed on unknown POST); TOTP enrollment + optional enforcement (guarded: cannot enable before enrolling); staff role changes audited; own-role change blocked. |
| Session hijack | Opaque random session ids; HttpOnly + Secure flags; revoke-sessions; login-as is audited and bannered. |
| Audit tampering | Hash-chained audit_log (prev_hash + sha256 of row contents), serialized inserts, /audit verifies the chain and shows a banner. Single-instance assumption: a multi-instance deployment would need a DB-side sequence to avoid chain forks. |
| XSS / injection | CSP (nonce-based, see server.js); EJS escaping by default; no per-ticket/per-user outcome overrides exist anywhere. |
| Password attacks | Role minimums (player 8, agent 10, admin 12), breached-password check (HIBP k-anonymity, fails open offline), login rate limits. |
| Maintenance bypass | All-methods maintenance gate (GET → 503 page, other methods → 503 JSON); allowlist is admin path, login/logout, impersonation exit, webhooks, healthz, verify-email, reset/forgot, force-reset, static assets. |

## Residual risks (honest list)
1. DB-insider seed pre-computation (see draw row above). Mitigation in place:
   beacon; full mitigation needs seed encryption or an external draw service.
2. Single-instance audit chain (see above).
3. No external pen-test / bug bounty yet — needs outside testers.
4. Live PSP server-to-server confirmation is provider-specific and not wired
   until merchant credentials + provider mapping exist (operator step).
5. Free-tier SQLite wipes on redeploy (hosting limitation, not code); the
   Postgres migration (v15) removes this class of risk.
6. `style-src 'unsafe-inline'` is retained for admin inline styles and
   operator custom_css — both operator-controlled, never user input.
