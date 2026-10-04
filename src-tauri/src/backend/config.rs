//! 全局配置 `til.toml` 的读取。
//!
//! 只回答一件事：**Python 后端在哪、怎么启动它。** 图库自身的配置
//! （library/inbox、阈值、上限）在 Python 侧的 `<root>/config.toml`，不归这里管。

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::error::BackendError;

/// 编译期内嵌一份，保证 `tauri dev` 零配置直接能跑。
///
/// 内嵌是合适的：这个配置装的是 `E:\Images` 这种**机器相关**的绝对路径，
/// 本来就只对这台机器有意义。下面 `load()` 的前三级查找留出打包后的覆盖口。
///
/// `include_str!` 会把文件登记成编译依赖，所以改了 `til.toml` 会触发重编译 ——
/// 想免重编译改配置，用环境变量 `TIL_CONFIG` 指到别处。
const EMBEDDED: &str = include_str!("../../til.toml");

/// 覆盖配置路径的环境变量。优先级最高，给调试用。
pub const CONFIG_ENV: &str = "TIL_CONFIG";

const FILE_NAME: &str = "til.toml";

/// `[backend]` 节。
#[derive(Debug, Clone, Deserialize)]
pub struct BackendConfig {
    /// Python 解释器。可以是绝对路径（venv 场景）
    #[serde(default = "default_python")]
    pub python: String,

    /// Python 脚本根目录：`backend/` 包的父目录，spawn 时的 cwd。
    ///
    /// **只影响 cwd**，不影响 library/inbox 的实际位置。
    pub root: PathBuf,

    /// 可选的 Python 侧 config.toml 路径，会以 `--config <路径>` 传给后端
    #[serde(default)]
    pub config: Option<PathBuf>,
}

fn default_python() -> String {
    "python".to_string()
}

#[derive(Debug, Clone, Deserialize)]
struct TilConfig {
    backend: BackendConfig,
}

impl BackendConfig {
    /// 按优先级找一个配置来用：
    ///
    /// 1. 环境变量 `TIL_CONFIG` 指向的文件
    /// 2. `<exe 所在目录>/til.toml`
    /// 3. `<app 配置目录>/til.toml`
    /// 4. 编译期内嵌的那份
    ///
    /// `app_config_dir` 由调用方从 Tauri 的 path API 取（`app.path().app_config_dir()`）；
    /// 传 `None` 就跳过第 3 级。做成参数而不是在这里取，是为了能脱离 Tauri 运行时测。
    pub fn load(app_config_dir: Option<&Path>) -> Result<Self, BackendError> {
        // 1. 环境变量
        if let Some(path) = std::env::var_os(CONFIG_ENV) {
            let path = PathBuf::from(path);
            return Self::from_file(&path);
        }

        // 2. exe 所在目录。打包后用户可以直接把 til.toml 丢在 exe 旁边
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let candidate = dir.join(FILE_NAME);
                if candidate.is_file() {
                    return Self::from_file(&candidate);
                }
            }
        }

        // 3. app 配置目录（Tauri 的 app_config_dir）
        if let Some(dir) = app_config_dir {
            let candidate = dir.join(FILE_NAME);
            if candidate.is_file() {
                return Self::from_file(&candidate);
            }
        }

        // 4. 内嵌兜底。相对路径相对 manifest 目录解析
        let config = Self::parse(EMBEDDED, "（编译期内嵌的 til.toml）")?;
        Ok(config.resolve_relative_to(Path::new(env!("CARGO_MANIFEST_DIR"))))
    }

    fn from_file(path: &Path) -> Result<Self, BackendError> {
        let text = std::fs::read_to_string(path).map_err(|e| BackendError::Config {
            message: format!("读不了配置文件 {}：{e}", path.display()),
        })?;
        let config = Self::parse(&text, &path.display().to_string())?;
        // 相对路径相对**配置文件所在目录**解析，不相对 CWD ——
        // 和 Python 侧 `_path()` 的约定保持一致，免得两边的相对路径含义不一样
        let base = path.parent().unwrap_or_else(|| Path::new("."));
        Ok(config.resolve_relative_to(base))
    }

    fn parse(text: &str, origin: &str) -> Result<Self, BackendError> {
        let parsed: TilConfig = toml::from_str(text).map_err(|e| BackendError::Config {
            message: format!(
                "配置文件 {origin} 解析失败：{e}\n\
                 （Windows 路径要用单引号字面量写：root = 'E:\\Images'，\
                 写成双引号会因为 \\I 不是合法转义而失败）"
            ),
        })?;
        Ok(parsed.backend)
    }

    fn resolve_relative_to(mut self, base: &Path) -> Self {
        if self.root.is_relative() {
            self.root = base.join(&self.root);
        }
        if let Some(cfg) = self.config.as_ref() {
            if cfg.is_relative() {
                self.config = Some(base.join(cfg));
            }
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内嵌的那份必须能解析 —— 它是 `tauri dev` 的唯一兜底，
    /// 解析不了的话开发期根本起不来。
    #[test]
    fn embedded_config_parses() {
        let config = BackendConfig::parse(EMBEDDED, "test").expect("内嵌配置应当能解析");
        assert!(!config.root.as_os_str().is_empty());
        assert!(!config.python.is_empty());
    }

    /// 双引号写 Windows 路径是经典翻车点，错误信息必须点破它
    #[test]
    fn double_quoted_windows_path_gets_helpful_error() {
        let bad = "[backend]\nroot = \"E:\\Images\"\n";
        let err = BackendConfig::parse(bad, "test").unwrap_err();
        let msg = err.to_json()["message"].as_str().unwrap_or("").to_string();
        assert!(msg.contains("单引号"), "错误信息应当提示用单引号，实际：{msg}");
    }

    #[test]
    fn single_quoted_windows_path_parses() {
        let good = "[backend]\nroot = 'E:\\Images'\n";
        let config = BackendConfig::parse(good, "test").expect("单引号应当能解析");
        assert_eq!(config.root, PathBuf::from(r"E:\Images"));
        // python 没写，应当落到默认值
        assert_eq!(config.python, "python");
        assert!(config.config.is_none());
    }

    /// 少写 root 必须报错，不能静默用空路径
    #[test]
    fn missing_root_is_an_error() {
        let bad = "[backend]\npython = 'python'\n";
        assert!(BackendConfig::parse(bad, "test").is_err());
    }
}
