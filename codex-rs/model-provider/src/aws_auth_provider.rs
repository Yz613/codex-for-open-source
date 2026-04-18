use codex_api::AuthProvider;
use codex_aws_auth::AwsAuthConfig;
use codex_aws_auth::AwsAuthContext;
use codex_aws_auth::AwsRequestToSign;
use codex_client::Request;
use http::HeaderMap;
use tokio::sync::OnceCell;

/// AWS SigV4 auth provider for OpenAI-compatible model-provider requests.
#[derive(Debug)]
pub(crate) struct AwsSigV4AuthProvider {
    config: AwsAuthConfig,
    context: OnceCell<AwsAuthContext>,
}

impl AwsSigV4AuthProvider {
    pub(crate) fn new(config: AwsAuthConfig) -> Self {
        Self {
            config,
            context: OnceCell::new(),
        }
    }

    async fn context(&self) -> Result<&AwsAuthContext, String> {
        self.context
            .get_or_try_init(|| AwsAuthContext::load(self.config.clone()))
            .await
            .map_err(|err| err.to_string())
    }
}

#[async_trait::async_trait]
impl AuthProvider for AwsSigV4AuthProvider {
    fn add_auth_headers(&self, _headers: &mut HeaderMap) {}

    async fn apply_auth(&self, mut request: Request) -> Result<Request, String> {
        let body = request.prepare_body_for_send()?;
        let context = self.context().await?;
        let signed = context
            .sign(AwsRequestToSign {
                method: request.method.clone(),
                url: request.url.clone(),
                headers: request.headers.clone(),
                body,
            })
            .await
            .map_err(|err| err.to_string())?;

        request.url = signed.url;
        request.headers = signed.headers;
        Ok(request)
    }
}
