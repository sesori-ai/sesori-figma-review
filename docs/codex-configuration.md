# Codex configuration contract

Codex support is staged and is not selectable in the plugin yet.

When Codex support is enabled in a later step, Sesori reuses the existing Codex login and configuration home. It does
not copy credentials or edit global Codex configuration. Before starting a review:

1. Finish any Codex user, project, or managed configuration changes.
2. Ensure managed settings do not force plugins, apps, hooks, subagents, web tools, or unrelated MCP servers on.
3. Keep relevant configuration unchanged until the review ends.

To change configuration, stop the review first and restart it after the change. Sesori discovers configured MCP,
plugin, and app names in memory, starts a separate process with those unrelated entries disabled, and validates the
final effective configuration before creating a review session. Names and configuration values are not persisted.

This is an operational freeze, not file locking or an atomic Codex configuration snapshot. Concurrent changes between
discovery and use are unsupported. Sesori fails closed when final configuration still exposes unrelated capabilities,
a configured server collides with its Figma server name, or managed settings override required disables.
