use serde::{Serialize, Serializer};

/// Error type returned to the frontend as `{ code, message }`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// A handled error reported by the Python worker.
    #[error("{message}")]
    Worker { code: String, message: String },
    #[error("The AI engine is not installed yet. Open Settings → AI engine to set it up.")]
    EngineMissing,
    #[error("Cancelled")]
    Cancelled,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Tauri(#[from] tauri::Error),
    #[error("{0}")]
    Message(String),
}

impl AppError {
    pub fn msg(m: impl Into<String>) -> Self {
        AppError::Message(m.into())
    }

    pub fn code(&self) -> &str {
        match self {
            AppError::Worker { code, .. } => code,
            AppError::EngineMissing => "engine_missing",
            AppError::Cancelled => "cancelled",
            AppError::Io(_) => "io",
            AppError::Json(_) => "json",
            AppError::Tauri(_) => "tauri",
            AppError::Message(_) => "error",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
