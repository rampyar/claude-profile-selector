# Changelog

## [4.0.0] - 2026-08-27
### Changed
- Converted icon to PNG for Marketplace compliance.
- Added MIT license and improved Marketplace metadata (keywords, categories).
- Prepared for VS Code Marketplace publication.

## [3.0.0] - 2026-08-26
### Added
- **Live Background Health Probing**: Extension now automatically tests models (working ✅, broken ❌, slow ⏳) when you open the picker!
- **Pricing Tags**: Smart model identification to display 🟢 FREE, 🟡 CHEAP, and 🔴 PAID models directly in the selection menu.
- **Provider Categories**: Intelligent section grouping (Antigravity, DuckDuckGo, AgentRouter, etc.).
- **New Icon**: Added a professional, OmniRoute-themed extension icon.
- **Improved Docs**: Added comprehensive README and documentation pages.

### Changed
- Refactored entire extension for speed and live OmniRoute compatibility.
- Re-mapped the `auto/*` routing logic.
- Cache TTL extended to 5 minutes to reduce unnecessary polling to `localhost:20128`.

## [2.0.0] - 2026-08-25
### Changed
- Total extension rewrite to fetch live from OmniRoute's `/v1/models` endpoint.
- Removed hardcoded models.
- Updated to securely read and preserve local workspace `.claude/settings.local.json`.

## [1.0.0] - Initial Release
### Added
- Initial VS Code profile selector for Claude Code.
