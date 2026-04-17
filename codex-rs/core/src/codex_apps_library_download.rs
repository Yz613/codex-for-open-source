use crate::codex::Session;
use crate::codex::TurnContext;
use codex_api::CoreAuthProvider;
use codex_api::download_openai_file;
use codex_login::CodexAuth;
use codex_mcp::CODEX_APPS_MCP_SERVER_NAME;
use codex_mcp::LIBRARY_DOWNLOAD_FILE_TOOL_NAME;
use codex_protocol::mcp::CallToolResult;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use tracing::warn;

const LIBRARY_DOWNLOAD_ARTIFACTS_DIR: &str = ".tmp/library_downloads";

#[derive(Debug, Deserialize, Serialize)]
struct LibraryDownloadStructuredContent {
    file_id: String,
    #[serde(default)]
    file_name: Option<String>,
    file_uri: LibraryDownloadFileUri,
}

#[derive(Debug, Deserialize, Serialize)]
struct LibraryDownloadFileUri {
    download_url: String,
    #[serde(default)]
    file_name: Option<String>,
}

pub(crate) async fn maybe_materialize_codex_apps_library_download_result(
    sess: &Session,
    turn_context: &TurnContext,
    server: &str,
    tool_name: &str,
    result: CallToolResult,
) -> CallToolResult {
    let auth = sess.services.auth_manager.auth().await;
    let client_metadata = sess.app_server_client_metadata().await;
    maybe_materialize_codex_apps_library_download_result_with_auth(
        turn_context,
        &sess.conversation_id.to_string(),
        auth.as_ref(),
        client_metadata.client_name.as_deref(),
        client_metadata.client_version.as_deref(),
        server,
        tool_name,
        result,
    )
    .await
}

async fn maybe_materialize_codex_apps_library_download_result_with_auth(
    turn_context: &TurnContext,
    session_id: &str,
    auth: Option<&CodexAuth>,
    client_name: Option<&str>,
    client_version: Option<&str>,
    server: &str,
    tool_name: &str,
    mut result: CallToolResult,
) -> CallToolResult {
    if server != CODEX_APPS_MCP_SERVER_NAME
        || tool_name != LIBRARY_DOWNLOAD_FILE_TOOL_NAME
        || result.is_error == Some(true)
    {
        return result;
    }

    let Some(payload) = extract_library_download_payload(&result) else {
        return result;
    };
    if result.structured_content.is_none()
        && let Ok(structured_content) = serde_json::to_value(&payload)
    {
        result.structured_content = Some(structured_content);
    }

    let Some(auth) = auth else {
        warn!("skipping Library download materialization because ChatGPT auth is unavailable");
        return result;
    };
    let token_data = match auth.get_token_data() {
        Ok(token_data) => token_data,
        Err(error) => {
            warn!(error = %error, "failed to read ChatGPT auth for Library download materialization");
            return result;
        }
    };
    let download_auth = CoreAuthProvider {
        token: Some(token_data.access_token),
        account_id: token_data
            .id_token
            .chatgpt_account_id
            .clone()
            .or(token_data.account_id),
        originator: client_name.map(str::to_string),
        user_agent: build_desktop_style_user_agent(client_name, client_version),
    };
    let downloaded = match download_openai_file(
        turn_context.config.chatgpt_base_url.trim_end_matches('/'),
        &download_auth,
        &payload.file_uri.download_url,
    )
    .await
    {
        Ok(downloaded) => downloaded,
        Err(error) => {
            warn!(
                error = %error,
                file_id = payload.file_id,
                "failed to materialize Library download via app-server",
            );
            return result;
        }
    };

    let artifact_path = library_download_artifact_path(
        &turn_context.config.codex_home,
        session_id,
        &payload.file_id,
        payload
            .file_name
            .as_deref()
            .or(payload.file_uri.file_name.as_deref())
            .unwrap_or("library_file"),
    );
    if let Some(parent) = artifact_path.parent()
        && let Err(error) = tokio::fs::create_dir_all(parent.as_path()).await
    {
        warn!(
            error = %error,
            path = %parent.display(),
            "failed to create Library download artifact directory",
        );
        return result;
    }
    if let Err(error) = tokio::fs::write(artifact_path.as_path(), &downloaded.bytes).await {
        warn!(
            error = %error,
            path = %artifact_path.display(),
            "failed to write Library download artifact",
        );
        return result;
    }

    let local_path = artifact_path.to_string_lossy().to_string();
    if let Some(JsonValue::Object(map)) = result.structured_content.as_mut() {
        map.insert(
            "local_path".to_string(),
            JsonValue::String(local_path.clone()),
        );
    }
    result.content.push(serde_json::json!({
        "type": "text",
        "text": format!("Downloaded library file to local path: {local_path}"),
    }));
    result
}

fn build_desktop_style_user_agent(
    client_name: Option<&str>,
    client_version: Option<&str>,
) -> Option<String> {
    let (Some(client_name), Some(client_version)) = (client_name, client_version) else {
        return None;
    };
    Some(format!(
        "{client_name}/{client_version} ({}; {})",
        std::env::consts::OS,
        std::env::consts::ARCH
    ))
}

fn extract_library_download_payload(
    result: &CallToolResult,
) -> Option<LibraryDownloadStructuredContent> {
    if let Some(structured_content) = result.structured_content.clone()
        && let Ok(payload) =
            serde_json::from_value::<LibraryDownloadStructuredContent>(structured_content)
    {
        return Some(payload);
    }

    result
        .content
        .iter()
        .filter_map(|item| item.as_object())
        .find_map(|item| {
            let text = item.get("text")?.as_str()?;
            serde_json::from_str::<LibraryDownloadStructuredContent>(text).ok()
        })
}

fn library_download_artifact_path(
    codex_home: &codex_utils_absolute_path::AbsolutePathBuf,
    session_id: &str,
    file_id: &str,
    file_name: &str,
) -> codex_utils_absolute_path::AbsolutePathBuf {
    codex_home
        .join(LIBRARY_DOWNLOAD_ARTIFACTS_DIR)
        .join(sanitize_path_component(session_id, "session"))
        .join(sanitize_path_component(file_id, "file"))
        .join(sanitize_file_name(file_name))
}

fn sanitize_path_component(value: &str, fallback: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn sanitize_file_name(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "library_file".to_string()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::make_session_and_context;
    use codex_login::CodexAuth;
    use pretty_assertions::assert_eq;
    use std::sync::Arc;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;
    use wiremock::matchers::header;
    use wiremock::matchers::method;
    use wiremock::matchers::path;

    #[tokio::test]
    async fn library_download_materialization_ignores_other_tools() {
        let (_, turn_context) = make_session_and_context().await;
        let original = CallToolResult {
            content: vec![serde_json::json!({"type": "text", "text": "hello"})],
            structured_content: Some(serde_json::json!({"x": 1})),
            is_error: Some(false),
            meta: None,
        };

        let result = maybe_materialize_codex_apps_library_download_result_with_auth(
            &turn_context,
            "session-1",
            Some(&CodexAuth::create_dummy_chatgpt_auth_for_testing()),
            Some("Codex Desktop"),
            Some("0.0.0"),
            CODEX_APPS_MCP_SERVER_NAME,
            "calendar/list_events",
            original.clone(),
        )
        .await;

        assert_eq!(result, original);
    }

    #[tokio::test]
    async fn library_download_materialization_adds_local_path_for_library_tool() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/files/download/file_123"))
            .and(header("authorization", "Bearer Access Token"))
            .and(header("chatgpt-account-id", "account_id"))
            .and(header("originator", "Codex Desktop"))
            .and(header("user-agent", "Codex Desktop/0.0.0 (macos; aarch64)"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/plain")
                    .set_body_bytes(b"library contents".to_vec()),
            )
            .mount(&server)
            .await;

        let (_, mut turn_context) = make_session_and_context().await;
        let mut config = (*turn_context.config).clone();
        config.chatgpt_base_url = format!("{}/backend-api/codex", server.uri());
        turn_context.config = Arc::new(config);
        let original = CallToolResult {
            content: vec![serde_json::json!({
                "type": "text",
                "text": "{\"file_id\":\"file_123\"}",
            })],
            structured_content: Some(serde_json::json!({
                "file_id": "file_123",
                "library_file_id": "libfile_123",
                "file_name": "testing-library.txt",
                "file_uri": {
                    "download_url": "/files/download/file_123",
                    "file_id": "file_123",
                    "file_name": "testing-library.txt",
                    "mime_type": "text/plain",
                }
            })),
            is_error: Some(false),
            meta: None,
        };

        let result = maybe_materialize_codex_apps_library_download_result_with_auth(
            &turn_context,
            "session-1",
            Some(&CodexAuth::create_dummy_chatgpt_auth_for_testing()),
            Some("Codex Desktop"),
            Some("0.0.0"),
            CODEX_APPS_MCP_SERVER_NAME,
            LIBRARY_DOWNLOAD_FILE_TOOL_NAME,
            original,
        )
        .await;

        let local_path = result
            .structured_content
            .as_ref()
            .and_then(|value| value.get("local_path"))
            .and_then(JsonValue::as_str)
            .expect("local_path in structured content");
        assert!(local_path.contains("library_downloads"));
        let saved = tokio::fs::read(local_path)
            .await
            .expect("saved local file should exist");
        assert_eq!(saved, b"library contents".to_vec());
        assert!(result.content.iter().any(|block| {
            block.get("type").and_then(JsonValue::as_str) == Some("text")
                && block
                    .get("text")
                    .and_then(JsonValue::as_str)
                    .is_some_and(|text| text.contains("Downloaded library file to local path:"))
        }));
    }

    #[tokio::test]
    async fn library_download_materialization_returns_original_result_without_chatgpt_auth() {
        let (_, turn_context) = make_session_and_context().await;
        let original = CallToolResult {
            content: vec![serde_json::json!({"type": "text", "text": "hello"})],
            structured_content: Some(serde_json::json!({
                "file_id": "file_123",
                "file_name": "testing-library.txt",
                "file_uri": {
                    "download_url": "/files/download/file_123",
                }
            })),
            is_error: Some(false),
            meta: None,
        };

        let result = maybe_materialize_codex_apps_library_download_result_with_auth(
            &turn_context,
            "session-1",
            None,
            Some("Codex Desktop"),
            Some("0.0.0"),
            CODEX_APPS_MCP_SERVER_NAME,
            LIBRARY_DOWNLOAD_FILE_TOOL_NAME,
            original.clone(),
        )
        .await;

        assert_eq!(result, original);
    }

    #[tokio::test]
    async fn library_download_materialization_uses_json_text_when_structured_content_is_missing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/files/download/file_123"))
            .and(header("authorization", "Bearer Access Token"))
            .and(header("chatgpt-account-id", "account_id"))
            .and(header("originator", "Codex Desktop"))
            .and(header("user-agent", "Codex Desktop/0.0.0 (macos; aarch64)"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/plain")
                    .set_body_bytes(b"library contents".to_vec()),
            )
            .mount(&server)
            .await;

        let (_, mut turn_context) = make_session_and_context().await;
        let mut config = (*turn_context.config).clone();
        config.chatgpt_base_url = format!("{}/backend-api/codex", server.uri());
        turn_context.config = Arc::new(config);
        let original = CallToolResult {
            content: vec![serde_json::json!({
                "type": "text",
                "text": serde_json::json!({
                    "file_id": "file_123",
                    "file_name": "testing-library.txt",
                    "file_uri": {
                        "download_url": "/files/download/file_123",
                        "file_name": "testing-library.txt",
                    }
                })
                .to_string(),
            })],
            structured_content: None,
            is_error: Some(false),
            meta: None,
        };

        let result = maybe_materialize_codex_apps_library_download_result_with_auth(
            &turn_context,
            "session-1",
            Some(&CodexAuth::create_dummy_chatgpt_auth_for_testing()),
            Some("Codex Desktop"),
            Some("0.0.0"),
            CODEX_APPS_MCP_SERVER_NAME,
            LIBRARY_DOWNLOAD_FILE_TOOL_NAME,
            original,
        )
        .await;

        let local_path = result
            .content
            .iter()
            .find_map(|item| {
                item.get("text")
                    .and_then(|text| text.as_str())
                    .and_then(|text| text.strip_prefix("Downloaded library file to local path: "))
            })
            .expect("expected local path announcement");
        assert_eq!(
            result.structured_content,
            Some(serde_json::json!({
                "file_id": "file_123",
                "file_name": "testing-library.txt",
                "file_uri": {
                    "download_url": "/files/download/file_123",
                    "file_name": "testing-library.txt",
                },
                "local_path": local_path,
            }))
        );
        assert_eq!(
            tokio::fs::read(local_path).await.expect("downloaded file"),
            b"library contents"
        );
    }
}
