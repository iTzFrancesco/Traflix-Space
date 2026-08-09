use serde::Deserialize;
use tracing::error;

const MAX_TOKEN_LEN: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendDiagnostic {
    kind: String,
    code: String,
    source: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    terminal_id: Option<String>,
    workspace_id: Option<String>,
    generation: Option<u64>,
    process_id: Option<u32>,
    request_id: Option<String>,
    state: Option<String>,
}

fn safe_token(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty()
            || trimmed.len() > MAX_TOKEN_LEN
            || !trimmed.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
            })
        {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// Persist a deliberately content-free frontend failure marker. There is no
/// message/stack field in this contract, so terminal output, prompts and
/// credentials cannot accidentally enter release crash logs.
#[tauri::command]
pub fn report_frontend_diagnostic(event: FrontendDiagnostic) -> Result<(), String> {
    let kind = safe_token(Some(event.kind))
        .ok_or_else(|| "invalid frontend diagnostic kind".to_string())?;
    let code = safe_token(Some(event.code))
        .ok_or_else(|| "invalid frontend diagnostic code".to_string())?;
    error!(
        diagnostic_kind = %kind,
        diagnostic_code = %code,
        source = ?safe_token(event.source),
        line = ?event.line,
        column = ?event.column,
        terminal_id = ?safe_token(event.terminal_id),
        workspace_id = ?safe_token(event.workspace_id),
        generation = ?event.generation,
        process_id = ?event.process_id,
        request_id = ?safe_token(event.request_id),
        state = ?safe_token(event.state),
        "Frontend diagnostic"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::safe_token;

    #[test]
    fn diagnostic_tokens_reject_free_form_or_oversized_content() {
        assert_eq!(
            safe_token(Some("terminal-output-gap".into())).as_deref(),
            Some("terminal-output-gap")
        );
        assert!(safe_token(Some("prompt with spaces".into())).is_none());
        assert!(safe_token(Some(r"C:\\Users\\owner\\secret.ts".into())).is_none());
        assert!(safe_token(Some("x".repeat(257))).is_none());
    }
}
