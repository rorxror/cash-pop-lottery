# LEGAL CHECKLIST — operator responsibilities

Plainly: **this software is a tool, not a certification.** Nothing in
this repository — no feature, toggle, document or comment — makes the
platform legal to operate anywhere. Licensing and compliance are the
**operator's** responsibility, in the operator's jurisdictions, with
the operator's own legal advice.

Before taking real money from real players, the operator must settle,
at minimum:

- **Gambling licence** for every jurisdiction whose residents can play
  (lottery/gaming law differs sharply by country and, in the US, by
  state) — obtained directly from the regulator, in the operating
  entity's name.
- **Entity + tax**: a registered company, tax registration, and a
  lawful way to hold player funds (segregation of player balances from
  operating funds where required).
- **Payments**: merchant accounts / payment processors that knowingly
  accept gambling transactions (gambling MCC) in the licensed entity's
  name; no concealed or mislabelled payment routing.
- **AML / KYC policy**: the software ships an optional KYC module
  (document submission + review, off by default) and audit trails — a
  tooling aid. Whether KYC is legally required, at what thresholds, and
  which documents are acceptable is the operator's policy decision.
- **Responsible gambling**: self-exclusion, cooling-off, deposit limits
  and wagering disclosures exist in the product; their exact form and
  prominence are regulated in many jurisdictions — verify against local
  rules.
- **Age verification**, geo-blocking of unlicensed territories (a
  blocked-countries setting exists for phone registration; full
  geo-policy is the operator's), privacy policy / GDPR-style data
  duties for stored identity documents, and consumer terms that match
  how the platform actually behaves (payout timing, fees, limits).
- **Game integrity claims**: draws use a public randomness beacon and
  scratch outcomes are predetermined per series — if you advertise
  "provably fair", your terms must describe the actual mechanism
  accurately.

If any item on this list is unresolved, the safe configuration is:
do not accept real-money play.
