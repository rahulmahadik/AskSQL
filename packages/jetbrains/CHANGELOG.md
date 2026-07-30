# Changelog

All notable changes to the AskSQL JetBrains plugin are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-07-31

- **Test Provider** button in Settings: makes a real model call, so a wrong key,
  model id, or base URL fails there instead of mid-question.
- **Ask About This Table**: right-click any table in the schema tree to seed the
  chat with a question about it.
- **Write-query proposals**: asking for an INSERT/UPDATE/DELETE/DDL returns the
  statement as a proposal with an explicit read-only note - never executed.
  (Enable *Answer schema questions in plain language* to get proposals instead
  of a refusal.)

## [0.1.0] - 2026-07-25

First release. Chat and Schema tool windows, pure Kotlin/JVM engine (JSqlParser guard, JDBC
connectivity for Postgres/MySQL/SQLite/DuckDB/Oracle, MongoDB via a separate `MongoEnginePipeline`,
OpenAI-compatible/Anthropic/Gemini streaming clients incl. NVIDIA/Groq/local-model presets),
PasswordSafe-backed secrets, sample-database and DuckDB file-upload onboarding, connection editor
with per-engine validation and a Test Connection button, and "Explain"/"Suggest a fix" actions.

### Highlights
- Read-only by construction: an AST guard plus an enforced read-only DB session on every query
  (allowlist-based `MongoGuard` for MongoDB, which has no server-enforced equivalent).
- Zero telemetry; secrets only ever live in the OS keychain.
- CI parity-tested against the published `@asksql/core` guard/prompt behavior.
