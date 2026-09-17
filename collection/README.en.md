# Collection Snapshots

**English | [中文](README.md)**

This directory pins **verified plugin tarballs** together with their provenance.

It exists for exactly one reason: **after upstream ships a new release, the version
that was verified here must still be installable.**

---

## ⚠️ What is collected is not necessarily the latest version

**This is by design, not a defect.**

What is collected here is the build that was **verified on a real machine in this
repository — installs cleanly and boots cleanly** — **not the newest upstream release.**
Those are frequently different versions, and deliberately so:

| | Collection principle | Upstream release cadence |
|---|---|---|
| Goal | Reproducible verified bytes | Ship new versions continuously |
| Cares about | Installs, does not crash | New features, changed structure |

When upstream ships a new release, any of these can happen — and these are exactly
what the snapshots exist to stop:

- Unpublishing an old version → existing users **cannot reinstall**
- Re-publishing different content under the same version → you **do not get the verified build**
- Tightening `peerDependencies` → a previously working dsh version **suddenly fails to install**
- Changing package structure (moving `lib/`, dropping `cordis.patch.yml`) → installs, but **nothing shows up in the UI**

So: **to adopt the latest version, verify it on a real machine per [`SPEC.md`](SPEC.md),
then add a new snapshot — never overwrite the old one.**

> Per-entry "is this the latest?" status lives in `manifest.json` under `isLatest`.
> A value of `null` means **the maintainer has not checked** — it does not mean "no".
> The verification rules are in [`SPEC.md`](SPEC.md) §3 step ③; **guessing is prohibited.**

---

## What is collected

**Runtime baseline: `dsh 0.1.6-alpha.1`** (channel `alpha`)

**11** packages total: **7** self-developed / **4** third-party.

| Package | Collected version | Origin | Author | Upstream | License |
|---|---|---|---|---|---|
| `@dsh-market/plugin` | 0.4.8 | third-party | 2BingLing | [2BingLing/dsh-market](https://github.com/2BingLing/dsh-market) | MIT |
| `dsh-workbuddy-connect` | 0.5.3 | third-party | corrinehu | [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | MIT |
| `dsh-connect-trae` | 2.0.1 | third-party | dingminhua | [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | MIT |
| `dsh-receipt` | 0.1.0 | third-party | <sub>unstated</sub> | [deronendless/dsh-receipt](https://github.com/deronendless/dsh-receipt) | MIT |
| `dsh-plugins-market` | 0.1.0 | **self** | HaydenSmith1121 | this repository | MIT |
| `dsh-opencode-go-plus` | 0.3.0 | **self** (derived) | HaydenSmith1121 | this repo, derived from [Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go) | MIT |
| `dsh-workbuddy-quota` | 0.2.0 | **self** | HaydenSmith1121 | this repository | MIT |
| `dsh-session-cleanup` | 0.1.2 | **self** | HaydenSmith1121 | this repository | MIT |
| `dsh-ark-plans` | 0.1.0 | **self** | HaydenSmith1121 | this repository | MIT |
| `dsh-memory` | 0.1.0 | **self** | HaydenSmith1121 | this repository | MIT |
| `dsh-excel-viewer` | 0.1.0 | **self** | HaydenSmith1121 | this repository | MIT |

### On provenance

- **Author** is taken from `author` in the package's `package.json`
- When that field is missing, it is **verified against the upstream declared in the package's `README.md`**
- If it cannot be determined, it is recorded as "**unstated**" — **never left blank, never guessed**

> **`@dsh-market/plugin`**: its `package.json` has no `author` / `repository` field;
> provenance was verified from the upstream declared in the bundled `README.md`.
> ⚠️ Its tarball ships **no LICENSE text** (`package.json` declares MIT).

> **`dsh-receipt`**: `package.json` has `repository` but **no `author`**, so the author
> is recorded as "unstated" — that is an accurate record, not an omission.

> **`dsh-opencode-go-plus`**: a **derived package** maintained here. Packaging, fixes and
> distribution are ours, but the code was not written from scratch — the baseline is
> `dsh-opencode-go@0.1.2` and only host-side logic was changed. Full attribution is in the
> package's `THIRD_PARTY_NOTICES.md` and `docs/derivation.md`. It **replaces** the older
> `dsh-opencode-go`; **the two cannot be installed into the same profile.**

> **`dsh-excel-viewer`**: a self-developed client renderer whose tarball **inlines**
> SheetJS Community Edition 0.20.3 (Apache-2.0, from the official SheetJS CDN). It is not a
> runtime dependency: dsh's browser module table only provides `react` and `@deepseek-ai/*`,
> so the parser must be inlined at build time. See the package's `THIRD_PARTY_NOTICES.md`.

**Copyright in third-party plugins belongs to their respective authors.** This repository
only performs offline packaging and indexing, and does not modify their license terms.

---

## Integrity verification

Every snapshot has a `sha256` recorded in [`manifest.json`](manifest.json). It guarantees
that what gets installed back is byte-for-byte the build that was verified.

```bash
# Regenerate the manifest and verify every sha256
node scripts/build-collection.mjs

# Verify only, write nothing (for CI)
node scripts/build-collection.mjs --check
```

A failed check reports exactly which entry mismatched (`compatibility.json` conflict /
missing snapshot / sha256 mismatch).

---

## Layout

```none
collection/
├─ README.md                  # this file: collection overview
├─ SPEC.md                    # collection specification (normative, for contributors)
├─ manifest.json              # machine-readable manifest (with sha256), generated
├─ collection-notes.json      # version verification results and collection rationale
└─ snapshots/
   └─ <dir>/<plugin-version>/<package>-<version>.tgz
```

Snapshots are **immutable**: a collected directory must not be modified, overwritten or
deleted. When upstream ships a new release, **add** a directory — do not replace the old one.

---

## Installation

**You do not need to use these tarballs by hand.** Open the "Plugin Market" entry in the
left sidebar of the GUI → "Verified" tab → click "Install". The market reads this directory
automatically and runs its pre-install compatibility gate.

See the repository root [`README.md`](../README.md) for details.

---

## Adding a collection

1. Read **[`SPEC.md`](SPEC.md)** — the collection rules are **mandatory**
2. Establish real provenance (version / author / upstream / license — all four required)
3. Verify on a real machine in an isolated environment
4. Register per the spec and run `node scripts/build-collection.mjs`

If you are unsure, open an Issue first — **never guess a version number or an author.**

---

## License

- The **documents and manifest** in this directory: MIT
- **Third-party plugin copyright belongs to their respective authors**; this repository
  only performs offline packaging and indexing
- If you are the author of a plugin and want its collection changed or removed, open an
  Issue or contact us directly and we will act promptly
