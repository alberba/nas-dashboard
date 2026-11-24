# API Coverage — Phase 01 (Auditoría del ruido)

No external API integration: the phase reads a local Telegram HTML export and an optional alerts CSV, makes no network calls, uses no third-party SDK and writes only local JSON and Markdown artifacts.

The API-coverage detector fires on prose in `01-RESEARCH.md` that mentions the Telegram Bot API limitation (the bot cannot list its own sent messages). That mention explains why the audit uses a local export; it is not an integration. The phase has no HTTP client, no credentials and no remote endpoint.
