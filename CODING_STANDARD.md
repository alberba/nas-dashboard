# Coding standard

## Tests assert behaviour

A test goes _red_ only when the product stops working. Copy (headings, slogans, messages, labels) changes freely, so a test never depends on it.

Assert on one of:

- **State**: a `data-view`, `aria-current`, `aria-expanded` or other attribute the component sets from its own state.
- **Outcome**: a URL, an HTTP status, a stored row, a request that was sent, a file that moved.
- **Structure**: a role or labelled control the user operates (`Entrar`, `Cerrar sesión`), found through `getByRole` or `getByLabel`.

When a component has no hook for the state you need, add a `data-*` attribute to the component and assert on that.

Applies to Playwright (`tests/e2e/`), Vitest (`tests/`) and the agent tests (`agent/test_*.py`).

Before finishing a change that edits user-facing text, grep `tests/` for the old string; a match is a test coupled to copy, so rewrite that test to assert behaviour.
