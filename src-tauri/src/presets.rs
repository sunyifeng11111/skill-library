use crate::AgentPreset;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// The persisted kind and the available presets come from one catalog.
macro_rules! presets {
    ($($kind:ident => ($name:literal, $directory:literal)),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub enum AgentKind {
            $($kind,)+
            Custom,
        }

        const CATALOG: &[(AgentKind, &str, &str)] = &[
            $((AgentKind::$kind, $name, $directory),)+
        ];
    };
}

// User-level deployment roots in xingkongliang/skills-manager's tool_adapters.rs,
// revision f374817aeb0ae648940dad7c15b49b610fb9eca2.
presets! {
    ClaudeCode => ("Claude Code", ".claude/skills"),
    Codex => ("Codex", ".codex/skills"),
    Cursor => ("Cursor", ".cursor/skills"),
    OmpAgent => ("OMP Agent", ".omp/agent/skills"),
    Grok => ("Grok", ".grok/skills"),
    Opencode => ("OpenCode", ".config/opencode/skills"),
    Antigravity => ("Antigravity", ".gemini/config/skills"),
    Amp => ("Amp", ".config/agents/skills"),
    KiloCode => ("Kilo Code", ".kilocode/skills"),
    RooCode => ("Roo Code", ".roo/skills"),
    Goose => ("Goose", ".config/goose/skills"),
    GeminiCli => ("Gemini CLI", ".gemini/skills"),
    GithubCopilot => ("GitHub Copilot", ".copilot/skills"),
    Openclaw => ("OpenClaw", ".openclaw/skills"),
    Droid => ("Droid", ".factory/skills"),
    Windsurf => ("Windsurf", ".codeium/windsurf/skills"),
    Trae => ("TRAE IDE", ".trae/skills"),
    SharedSkills => ("Shared Skills", ".agents/skills"),
    Cline => ("Cline", ".agents/skills"),
    Deepagents => ("Deep Agents", ".deepagents/agent/skills"),
    Firebender => ("Firebender", ".firebender/skills"),
    Kimi => ("Kimi Code CLI", ".kimi-code/skills"),
    Replit => ("Replit", ".config/agents/skills"),
    Warp => ("Warp", ".agents/skills"),
    Augment => ("Augment", ".augment/skills"),
    Bob => ("IBM Bob", ".bob/skills"),
    Codebuddy => ("CodeBuddy", ".codebuddy/skills"),
    CommandCode => ("Command Code", ".commandcode/skills"),
    Continue => ("Continue", ".continue/skills"),
    Cortex => ("Cortex Code", ".snowflake/cortex/skills"),
    Crush => ("Crush", ".config/crush/skills"),
    Iflow => ("iFlow CLI", ".iflow/skills"),
    Junie => ("Junie", ".junie/skills"),
    Kiro => ("Kiro CLI", ".kiro/skills"),
    Kode => ("Kode", ".kode/skills"),
    Mcpjam => ("MCPJam", ".mcpjam/skills"),
    MistralVibe => ("Mistral Vibe", ".vibe/skills"),
    Mux => ("Mux", ".mux/skills"),
    Neovate => ("Neovate", ".neovate/skills"),
    Openhands => ("OpenHands", ".openhands/skills"),
    Pi => ("Pi", ".pi/agent/skills"),
    Pochi => ("Pochi", ".pochi/skills"),
    Qoder => ("Qoder", ".qoder/skills"),
    QwenCode => ("Qwen Code", ".qwen/skills"),
    TraeCn => ("TRAE CN", ".trae-cn/skills"),
    Zencoder => ("Zencoder", ".zencoder/skills"),
    Zcode => ("ZCode", ".zcode/skills"),
    Adal => ("AdaL", ".adal/skills"),
    Hermes => ("Hermes Agent", ".hermes/skills"),
    Qclaw => ("QClaw", ".qclaw/skills"),
    Easyclaw => ("EasyClaw", ".easyclaw/skills"),
    Autoclaw => ("AutoClaw", ".openclaw-autoclaw/skills"),
    Workbuddy => ("WorkBuddy", ".workbuddy/skills"),
    WorkbuddyOverseas => ("WorkBuddy AI", ".workbuddy-ai/skills"),
    DeepseekHarness => ("DeepSeek Harness", ".dsh/skills"),
    GitlabDuo => ("GitLab Duo", ".gitlab/duo/skills"),
    MinimaxCode => ("MiniMax Code", ".minimax/skills"),
}

pub fn agent_presets(home: &Path) -> Vec<AgentPreset> {
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    CATALOG
        .iter()
        .map(|&(kind, name, relative)| {
            let directory = match (kind, &codex_home) {
                (AgentKind::Codex, Some(root)) => root.join("skills"),
                (AgentKind::SharedSkills, _) => {
                    let path = home.join(relative);
                    path.canonicalize().unwrap_or(path)
                }
                _ => home.join(relative),
            };
            AgentPreset {
                kind,
                name,
                directory,
            }
        })
        .collect()
}
