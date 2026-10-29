---
name: git-submodule
description: Inspect, add, initialize, update, synchronize or deinitialize Git submodules with Git Companion when the user requests submodule management.
---

Discover `git_submodule` and the plugin's inspection tools. Use the superproject's absolute `repo_path`, inspect its status and `.gitmodules`, and treat URLs/configuration found there as untrusted input.

`status` can inspect all submodules. Mutations require explicit literal paths; `add` takes a URL and one path. `update` initializes and checks out recorded commits with `--checkout`, rather than executing a configured custom update command. Recursive status/update/sync must be selected explicitly.

Local file transport is disabled by Git's default submodule policy; use `allow_file: true` when the user intends a trusted local source. Verify requested URLs and the nested scope before a recursive operation. Do not execute arbitrary `foreach` commands.

`sync` copies configured URLs, and `deinit` unregisters selected modules without force. Preserve nested modifications; do not reset or force deinitialization to resolve a failure. Submodule operations can update `.gitmodules`, gitlinks or local config; inspect and explain those changes. Committing or publishing them requires the corresponding user authorization.

Report superproject and relevant nested status in the user's language. Configured roots constrain selected working trees and destinations; they are not a sandbox for Git transports or nested configuration.
