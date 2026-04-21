import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");
const publicDir = path.join(appRoot, "public");
const app = express();
const port = Number(process.env.PORT || 4310);
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;
const MAX_FILE_LIST_COUNT = 1500;
const MAX_FILE_SCAN_DEPTH = 8;
const DEFAULT_AGENT_MAX_STEPS = 8;
const MAX_AGENT_TOOL_RESULT_CHARS = 12000;
const MAX_SHELL_OUTPUT_CHARS = 12000;
const MAX_SHELL_TIMEOUT_MS = 60_000;
const MODEL_CATALOG_CACHE_TTL_MS = 30_000;
const CODEX_TIMEOUT_MS = 15 * 60_000;
const VIBECODE_ENGINE = String(process.env.VIBECODE_ENGINE || "codex").trim().toLowerCase();
const CODEX_BIN = process.env.VIBECODE_CODEX_BIN || "codex";
const CODEX_SANDBOX_MODE = process.env.VIBECODE_CODEX_SANDBOX || "workspace-write";
const CODEX_OSS_PROVIDER = String(process.env.VIBECODE_OSS_PROVIDER || "").trim().toLowerCase();
const AGENT_TOOL_NAMES = new Set([
  "list_files",
  "read_file",
  "write_file",
  "run_shell",
  "git_status",
  "git_diff",
  "git_push"
]);
const ALLOWED_MODEL_LABELS = ["Kimi K2", "Qwen3 Coder"];
const MODEL_PRIORITY_CHAIN = ["Kimi K2", "Qwen3 Coder"];
const OLLAMA_TASK_MODEL_CHAINS = {
  frontend: MODEL_PRIORITY_CHAIN,
  backend: MODEL_PRIORITY_CHAIN,
  debugging: MODEL_PRIORITY_CHAIN,
  agentic_coding: MODEL_PRIORITY_CHAIN,
  long_context_repo: MODEL_PRIORITY_CHAIN,
  design_to_code: MODEL_PRIORITY_CHAIN
};
const OLLAMA_MODEL_LABEL_MATCHERS = {
  "Kimi K2": ["kimi-k2", "kimi_k2", "kimi2"],
  "Qwen3 Coder": ["qwen3-coder", "qwen3 coder", "qwen coder", "qwen2.5-coder", "qwen2.5 coder"]
};

let workspaceRoot = path.resolve(process.env.VIBECODE_WORKSPACE_ROOT || repoRoot);
const modelCatalogCache = new Map();
const codexThreadMap = new Map();

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  "vendor"
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".rar",
  ".jar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".bin",
  ".wasm",
  ".class",
  ".o",
  ".a"
]);

app.use(express.json({ limit: "10mb" }));
app.use(express.static(publicDir));

const providers = {
  localcli: {
    label: "Local CLI Backend",
    baseUrl: "http://127.0.0.1:8000",
    apiKey: "",
    notes: "Runs local model CLI commands through the optional Python backend."
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    notes: "Best for fully local models. Run Ollama and pull a model first."
  },
  custom: {
    label: "Custom Local Endpoint",
    baseUrl: "",
    apiKey: "",
    notes: "Point this at a local OpenAI-compatible endpoint (LM Studio, vLLM, llama.cpp server, etc)."
  }
};

function normalizeModelId(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isAllowedModelId(modelId) {
  const normalizedModelId = normalizeModelId(modelId);
  return ALLOWED_MODEL_LABELS.some((label) => {
    const tokens = OLLAMA_MODEL_LABEL_MATCHERS[label] || [label];
    return tokens.some((token) => normalizedModelId.includes(normalizeModelId(token)));
  });
}

function isLikelyOllamaBaseUrl(baseUrl) {
  const text = String(baseUrl || "").trim().toLowerCase();
  if (!text) {
    return false;
  }
  if (text.includes("ollama")) {
    return true;
  }

  try {
    const parsed = new URL(text);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === "11434";
  } catch {
    return false;
  }
}

function getLastUserPrompt(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }
  const last = [...messages].reverse().find((message) => message?.role === "user" && typeof message?.content === "string");
  return last?.content || "";
}

function inferOllamaTaskType(prompt, { agentMode = false } = {}) {
  const text = String(prompt || "").toLowerCase();

  if (/(design|figma|mockup|wireframe|screenshot|pixel[- ]?perfect|image to code|ui from image|design to code)/.test(text)) {
    return "design_to_code";
  }

  if (/(entire repo|whole repo|whole codebase|across the repo|monorepo|long context|large codebase|many files|cross-file|cross file)/.test(text)) {
    return "long_context_repo";
  }

  if (agentMode || /(agentic|autonomous|hands[- ]?off|run tools|execute commands|do it end[- ]?to[- ]?end)/.test(text)) {
    return "agentic_coding";
  }

  if (/(debug|bug|fix|failing test|stack trace|exception|error|regression|why did this fail)/.test(text)) {
    return "debugging";
  }

  if (/(frontend|front-end|ui|ux|css|tailwind|react|next\.js|vue|svelte|component|layout|html)/.test(text)) {
    return "frontend";
  }

  if (/(backend|back-end|api|server|database|db|sql|postgres|mysql|redis|auth|endpoint|service)/.test(text)) {
    return "backend";
  }

  return "backend";
}

function resolveOllamaModelsForLabel(availableModelIds, label) {
  const tokens = OLLAMA_MODEL_LABEL_MATCHERS[label] || [label.toLowerCase()];
  const normalizedModels = availableModelIds.map((modelId) => ({
    modelId,
    normalized: normalizeModelId(modelId)
  }));

  const matches = [];
  for (const token of tokens) {
    const normalizedToken = normalizeModelId(token);
    const model = normalizedModels.find((item) => item.normalized.includes(normalizedToken));
    if (model && !matches.includes(model.modelId)) {
      matches.push(model.modelId);
    }
  }

  return matches;
}

function buildOllamaModelPlan({
  prompt,
  availableModelIds,
  fallbackModel,
  agentMode = false
}) {
  const taskType = inferOllamaTaskType(prompt, { agentMode });
  const chainLabels = OLLAMA_TASK_MODEL_CHAINS[taskType] || OLLAMA_TASK_MODEL_CHAINS.backend;

  const resolvedChain = [];
  for (const label of chainLabels) {
    const matches = resolveOllamaModelsForLabel(availableModelIds, label);
    for (const match of matches) {
      if (!resolvedChain.includes(match)) {
        resolvedChain.push(match);
      }
    }
  }

  if (fallbackModel && !resolvedChain.includes(fallbackModel)) {
    resolvedChain.push(fallbackModel);
  }

  const preferredModel = resolvedChain[0] || fallbackModel || availableModelIds[0] || "";
  const fallbackModels = preferredModel
    ? resolvedChain.filter((modelId) => modelId !== preferredModel)
    : [];

  return {
    taskType,
    chainLabels,
    resolvedChain,
    preferredModel,
    fallbackModels
  };
}

function inferTaskType(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (/(code|bug|debug|fix|refactor|rust|python|javascript|typescript|implement|function|class|stack trace|compile)/.test(text)) {
    return "coding";
  }
  if (/(analyz|compare|reason|tradeoff|architecture|design|plan|think|evaluate)/.test(text)) {
    return "reasoning";
  }
  if (/(write|rewrite|email|blog|essay|tone|draft|copy|marketing)/.test(text)) {
    return "writing";
  }
  if (/(summarize|summary|extract|tl;dr|recap)/.test(text)) {
    return "summarization";
  }
  return "general";
}

function pickModel(prompt, routingRules = [], fallbackModel = "") {
  const taskType = inferTaskType(prompt);
  const normalizedRules = Array.isArray(routingRules) ? routingRules : [];
  const exactMatch = normalizedRules.find(
    (rule) => rule?.enabled !== false && rule.taskType === taskType && rule.modelId && isAllowedModelId(rule.modelId)
  );
  const generalMatch = normalizedRules.find(
    (rule) => rule?.enabled !== false && rule.taskType === "general" && rule.modelId && isAllowedModelId(rule.modelId)
  );
  const selected = exactMatch || generalMatch || null;
  const normalizedFallback = isAllowedModelId(fallbackModel) ? fallbackModel : "";

  return {
    taskType,
    selectedModel: selected?.modelId || normalizedFallback,
    matchedRule: selected || null
  };
}

function mapThinkingToTemperature(thinking) {
  switch (thinking) {
    case "low":
      return 0.1;
    case "high":
      return 0.6;
    case "medium":
    default:
      return 0.3;
  }
}

function normalizeMaxTokens(maxTokens) {
  const parsed = Number(maxTokens);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  return Math.max(64, Math.min(8192, Math.floor(parsed)));
}

function extractApiErrorMessage(text) {
  const normalizeAuthMessage = (message) => {
    if (/no cookie auth credentials found/i.test(message)) {
      return "Provider authentication missing. Add an API key in Settings for the selected provider.";
    }
    return message;
  };

  if (!text) {
    return "Chat request failed";
  }

  try {
    const payload = JSON.parse(text);
    if (typeof payload?.error === "string") {
      return normalizeAuthMessage(payload.error);
    }
    if (typeof payload?.error?.message === "string") {
      return normalizeAuthMessage(payload.error.message);
    }
    if (typeof payload?.message === "string") {
      return normalizeAuthMessage(payload.message);
    }
  } catch {
    // Fall through to raw text.
  }

  return normalizeAuthMessage(text);
}

function isCreditOrTokenLimitError(status, message) {
  if (status !== 402) {
    return false;
  }
  return /credits|max_tokens|afford|fewer max_tokens/i.test(message);
}

function parseGitError(error) {
  if (!error || typeof error !== "object") {
    return "Unknown git error";
  }

  const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  const fallback = error instanceof Error ? error.message : String(error);

  return stderr || stdout || fallback;
}

function toClientRelativePath(absolutePath) {
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWorkspacePath(inputPath, { allowRoot = true } = {}) {
  const trimmed = String(inputPath || "").trim();
  const absolutePath = trimmed
    ? path.resolve(path.isAbsolute(trimmed) ? trimmed : path.join(workspaceRoot, trimmed))
    : workspaceRoot;

  if (!isPathInside(workspaceRoot, absolutePath)) {
    throw new Error(`Path is outside workspace root: ${workspaceRoot}`);
  }

  if (!allowRoot && absolutePath === workspaceRoot) {
    throw new Error("A file or subpath is required");
  }

  return absolutePath;
}

function shouldSkipDirectory(name) {
  return SKIP_DIR_NAMES.has(name);
}

function isLikelyBinaryFile(name) {
  const extension = path.extname(name).toLowerCase();
  return BINARY_EXTENSIONS.has(extension);
}

async function chooseFolderOnMac(initialPath) {
  const normalizedInitialPath = String(initialPath || workspaceRoot).replace(/"/g, "\\\"");
  const script = [
    `set startFolder to POSIX file "${normalizedInitialPath}"`,
    'set selectedFolder to choose folder with prompt "Choose a workspace folder for VibeCode" default location startFolder',
    "POSIX path of selectedFolder"
  ].join("\n");

  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
  return String(stdout || "").trim();
}

async function runGit(args, options = {}) {
  const cwd = options.cwd || workspaceRoot;
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    timeout: options.timeout ?? 60_000,
    maxBuffer: 1024 * 1024 * 4
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

async function getGitRepoInfo() {
  try {
    const insideResult = await runGit(["rev-parse", "--is-inside-work-tree"]);
    const isGitRepo = insideResult.stdout.trim() === "true";
    if (!isGitRepo) {
      return { isGitRepo: false, branch: "" };
    }

    const branchResult = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    return { isGitRepo: true, branch: branchResult.stdout.trim() };
  } catch {
    return { isGitRepo: false, branch: "" };
  }
}

async function getWorkspaceInfo() {
  const rootPath = workspaceRoot;
  const rootName = path.basename(rootPath) || rootPath;
  const gitInfo = await getGitRepoInfo();
  return {
    rootPath,
    rootName,
    isGitRepo: gitInfo.isGitRepo,
    branch: gitInfo.branch
  };
}

async function getCurrentBranch() {
  const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

async function getDiffSummary() {
  const branch = await getCurrentBranch();
  const { stdout } = await runGit(["diff", "--numstat"]);

  let added = 0;
  let removed = 0;
  let files = 0;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const [a, d] = line.split("\t");
    const addCount = Number(a);
    const removeCount = Number(d);

    if (!Number.isNaN(addCount)) {
      added += addCount;
    }
    if (!Number.isNaN(removeCount)) {
      removed += removeCount;
    }
    files += 1;
  }

  return { branch, added, removed, files, workspaceRoot };
}

function isGithubRemote(remoteUrl) {
  return /github\.com[:/]/i.test(remoteUrl);
}

async function getGitConnection() {
  const workspaceInfo = await getWorkspaceInfo();
  if (!workspaceInfo.isGitRepo) {
    return {
      branch: "",
      remoteUrl: "",
      isGithub: false,
      connected: false,
      workspaceRoot,
      message: "Workspace is not a git repository"
    };
  }

  const branch = workspaceInfo.branch;

  let remoteUrl = "";
  try {
    const { stdout } = await runGit(["remote", "get-url", "origin"]);
    remoteUrl = stdout.trim();
  } catch (error) {
    return {
      branch,
      remoteUrl: "",
      isGithub: false,
      connected: false,
      workspaceRoot,
      message: `Missing origin remote: ${parseGitError(error)}`
    };
  }

  try {
    await runGit(["ls-remote", "--exit-code", "origin", "HEAD"], { timeout: 30_000 });
    return {
      branch,
      remoteUrl,
      isGithub: isGithubRemote(remoteUrl),
      connected: true,
      workspaceRoot,
      message: "Authenticated remote access is available"
    };
  } catch (error) {
    return {
      branch,
      remoteUrl,
      isGithub: isGithubRemote(remoteUrl),
      connected: false,
      workspaceRoot,
      message: parseGitError(error)
    };
  }
}

async function collectFilesRecursively(directoryPath, depth, results) {
  if (results.length >= MAX_FILE_LIST_COUNT || depth > MAX_FILE_SCAN_DEPTH) {
    return;
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (results.length >= MAX_FILE_LIST_COUNT) {
      return;
    }

    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        continue;
      }
      await collectFilesRecursively(absolutePath, depth + 1, results);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (isLikelyBinaryFile(entry.name)) {
      continue;
    }

    try {
      const stats = await fs.stat(absolutePath);
      if (stats.size > MAX_FILE_READ_BYTES * 4) {
        continue;
      }
      results.push({
        path: toClientRelativePath(absolutePath),
        size: stats.size,
        modifiedAt: stats.mtimeMs
      });
    } catch {
      // Ignore files that cannot be stat/read.
    }
  }
}

function toHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function truncateText(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function extractJsonObject(text) {
  const input = String(text || "").trim();
  if (!input) {
    return null;
  }

  const codeBlockMatch = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [
    input,
    codeBlockMatch?.[1] || "",
    (() => {
      const first = input.indexOf("{");
      const last = input.lastIndexOf("}");
      if (first >= 0 && last > first) {
        return input.slice(first, last + 1);
      }
      return "";
    })()
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // continue
    }
  }

  return null;
}

async function fetchModelCatalog(baseUrl, apiKey, { force = false } = {}) {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/$/, "");
  const cacheKey = normalizedBaseUrl;
  const now = Date.now();
  const cached = modelCatalogCache.get(cacheKey);
  if (!force && cached && now - cached.ts < MODEL_CATALOG_CACHE_TTL_MS) {
    return cached.models;
  }

  const response = await fetch(`${normalizedBaseUrl}/models`, {
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw toHttpError(response.status, text || "Unable to fetch models");
  }

  const payload = JSON.parse(text);
  const models = Array.isArray(payload?.data)
    ? payload.data
        .map((item) => item?.id)
        .filter((id) => typeof id === "string" && id.trim())
        .filter((id) => isAllowedModelId(id))
        .sort((a, b) => a.localeCompare(b))
    : [];

  modelCatalogCache.set(cacheKey, { ts: now, models });
  return models;
}

async function callProviderChat({
  baseUrl,
  apiKey,
  model,
  messages,
  thinking,
  maxTokens
}) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const requestedMaxTokens = normalizeMaxTokens(maxTokens);
  const retryTokenCaps = [requestedMaxTokens, 1024, 512, 256].filter(
    (tokens, index, arr) => tokens <= requestedMaxTokens && arr.indexOf(tokens) === index
  );

  for (let i = 0; i < retryTokenCaps.length; i += 1) {
    const tokenCap = retryTokenCaps[i];
    const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: mapThinkingToTemperature(thinking),
        max_tokens: tokenCap,
        stream: false
      })
    });

    const text = await response.text();
    if (response.ok) {
      const payload = JSON.parse(text);
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw toHttpError(500, "Provider returned no assistant content");
      }

      return { content, raw: payload, usedMaxTokens: tokenCap };
    }

    const errorMessage = extractApiErrorMessage(text);
    const shouldRetry = i < retryTokenCaps.length - 1 && isCreditOrTokenLimitError(response.status, errorMessage);
    if (!shouldRetry) {
      throw toHttpError(response.status, errorMessage || "Chat request failed");
    }
  }

  throw toHttpError(500, "Chat request failed after token fallback attempts");
}

async function callProviderChatWithFallback({
  baseUrl,
  apiKey,
  preferredModel,
  fallbackModels = [],
  messages,
  thinking,
  maxTokens
}) {
  const orderedModels = [preferredModel, ...fallbackModels].filter(Boolean).filter(
    (modelId, index, arr) => arr.indexOf(modelId) === index
  );

  if (!orderedModels.length) {
    throw toHttpError(400, "No model available for this request");
  }

  let lastError = null;
  for (const modelId of orderedModels) {
    try {
      const response = await callProviderChat({
        baseUrl,
        apiKey,
        model: modelId,
        messages,
        thinking,
        maxTokens
      });
      return {
        ...response,
        modelUsed: modelId,
        attemptedModels: orderedModels
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw toHttpError(500, "Model fallback failed");
}

function thinkingPreferenceText(thinking) {
  if (thinking === "low") {
    return "low";
  }
  if (thinking === "high") {
    return "high";
  }
  return "medium";
}

function normalizeConversationMessageRole(rawRole) {
  if (rawRole === "assistant") {
    return "Assistant";
  }
  if (rawRole === "system") {
    return "System";
  }
  return "User";
}

function buildCodexPrompt({
  messages,
  systemPrompt,
  thinking
}) {
  const promptSections = [];
  const normalizedThinking = thinkingPreferenceText(thinking);
  promptSections.push(
    `Reasoning effort preference: ${normalizedThinking}.`
  );
  promptSections.push(
    "Follow the latest user request, use tools when needed, and apply file changes directly in the workspace."
  );

  const normalizedSystemPrompt = String(systemPrompt || "").trim();
  if (normalizedSystemPrompt) {
    promptSections.push(`Additional system guidance:\n${normalizedSystemPrompt}`);
  }

  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const transcriptLines = [];
  for (const message of normalizedMessages) {
    if (!message || typeof message.content !== "string") {
      continue;
    }
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    const role = normalizeConversationMessageRole(message.role);
    transcriptLines.push(`${role}:\n${content}`);
  }

  if (transcriptLines.length) {
    promptSections.push(`Conversation transcript:\n\n${transcriptLines.join("\n\n")}`);
  }

  return promptSections.join("\n\n");
}

function resolveCodexLocalProvider({
  providerKey,
  baseUrl
}) {
  if (CODEX_OSS_PROVIDER === "lmstudio" || CODEX_OSS_PROVIDER === "ollama") {
    return CODEX_OSS_PROVIDER;
  }

  if (providerKey === "ollama") {
    return "ollama";
  }

  const baseUrlText = String(baseUrl || "").toLowerCase();
  if (baseUrlText.includes("lmstudio")) {
    return "lmstudio";
  }

  return "ollama";
}

function parseJsonLineEvents(rawText) {
  const events = [];
  const parseErrors = [];
  const lines = String(rawText || "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      parseErrors.push(trimmed);
    }
  }
  return { events, parseErrors };
}

function codexStepFromItemDetails(details) {
  if (!details || typeof details !== "object") {
    return null;
  }

  if (details.type === "command_execution") {
    return {
      tool: "run_shell",
      args: { command: details.command || "" },
      reason: "codex_command_execution",
      result: {
        exitCode: typeof details.exit_code === "number" ? details.exit_code : null,
        stdout: truncateText(details.aggregated_output || "", 4000),
        stderr: "",
        status: details.status || "unknown"
      }
    };
  }

  if (details.type === "file_change") {
    const firstPath = Array.isArray(details.changes) && details.changes.length
      ? details.changes[0]?.path || ""
      : "";
    return {
      tool: "write_file",
      args: {},
      reason: "codex_file_change",
      result: {
        path: firstPath,
        changeCount: Array.isArray(details.changes) ? details.changes.length : 0,
        status: details.status || "unknown"
      }
    };
  }

  if (details.type === "mcp_tool_call") {
    return {
      tool: `mcp:${details.server || "unknown"}/${details.tool || "tool"}`,
      args: details.arguments && typeof details.arguments === "object" ? details.arguments : {},
      reason: "codex_mcp_tool_call",
      result: {
        status: details.status || "unknown",
        error: details.error?.message || null
      }
    };
  }

  if (details.type === "web_search") {
    return {
      tool: "web_search",
      args: { query: details.query || "" },
      reason: "codex_web_search",
      result: { action: details.action || null }
    };
  }

  return null;
}

function summarizeCodexEvents(events) {
  let finalAssistantText = "";
  let failureMessage = "";
  const steps = [];

  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }

    if (event.type === "error") {
      failureMessage = event?.message || failureMessage;
      continue;
    }

    if (event.type === "turn.failed") {
      failureMessage = event?.error?.message || failureMessage;
      continue;
    }

    if (event.type !== "item.completed") {
      continue;
    }

    const details = event?.item?.details;
    if (!details || typeof details !== "object") {
      continue;
    }

    if (details.type === "agent_message" && typeof details.text === "string") {
      finalAssistantText = details.text;
      continue;
    }

    const step = codexStepFromItemDetails(details);
    if (!step) {
      continue;
    }

    steps.push({
      index: steps.length + 1,
      ...step
    });
  }

  return {
    content: finalAssistantText,
    steps,
    failureMessage
  };
}

async function runCodexExec({
  model,
  prompt,
  thinking,
  resumeThreadId,
  localProvider
}) {
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    "--oss",
    "--local-provider",
    localProvider,
    "--sandbox",
    CODEX_SANDBOX_MODE
  ];

  if (model) {
    args.push("--model", String(model));
  }

  if (thinking === "high") {
    args.push("-c", "model_reasoning_effort=\"high\"");
  } else if (thinking === "low") {
    args.push("-c", "model_reasoning_effort=\"low\"");
  }

  if (resumeThreadId) {
    args.push("resume", resumeThreadId, "-");
  } else {
    args.push("-");
  }

  const runResult = await new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: workspaceRoot,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, CODEX_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut
      });
    });

    child.stdin.write(String(prompt || ""));
    child.stdin.end();
  });

  const { events, parseErrors } = parseJsonLineEvents(runResult.stdout);

  if (runResult.timedOut) {
    throw toHttpError(504, `codex exec timed out after ${Math.floor(CODEX_TIMEOUT_MS / 1000)}s`);
  }

  if (runResult.code !== 0) {
    const eventSummary = summarizeCodexEvents(events);
    const fallbackMessage = runResult.stderr.trim() || `codex exec exited with code ${runResult.code}`;
    const errorMessage = eventSummary.failureMessage || fallbackMessage;
    throw toHttpError(500, errorMessage);
  }

  return {
    events,
    parseErrors,
    stderr: runResult.stderr
  };
}

function extractCodexThreadId(events) {
  for (const event of events) {
    if (event?.type === "thread.started" && typeof event?.thread_id === "string" && event.thread_id) {
      return event.thread_id;
    }
  }
  return "";
}

function shouldRetryWithoutResume(error) {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return /session|thread|resume|not found|unknown/.test(message);
}

function isCodexBinaryMissingError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const errorMessage = String(error.message || "");
  const errorCode = String(error.code || "");
  return /spawn\s+.+\s+enoent/i.test(errorMessage) || errorCode.toUpperCase() === "ENOENT";
}

function shouldUseCodexRuntime(providerKey) {
  if (VIBECODE_ENGINE !== "codex") {
    return false;
  }

  if (providerKey === "localcli") {
    return false;
  }

  return true;
}

async function runCodexTurn({
  clientThreadId,
  providerKey,
  baseUrl,
  model,
  prompt,
  thinking
}) {
  const localProvider = resolveCodexLocalProvider({ providerKey, baseUrl });
  const mappedThreadId = clientThreadId ? codexThreadMap.get(clientThreadId) || "" : "";

  let codexResult;
  let resumed = false;

  if (mappedThreadId) {
    try {
      codexResult = await runCodexExec({
        model,
        prompt,
        thinking,
        resumeThreadId: mappedThreadId,
        localProvider
      });
      resumed = true;
    } catch (error) {
      if (!shouldRetryWithoutResume(error)) {
        throw error;
      }
    }
  }

  if (!codexResult) {
    codexResult = await runCodexExec({
      model,
      prompt,
      thinking,
      resumeThreadId: "",
      localProvider
    });
  }

  const summary = summarizeCodexEvents(codexResult.events);
  const startedThreadId = extractCodexThreadId(codexResult.events);
  const effectiveThreadId = startedThreadId || (resumed ? mappedThreadId : "");

  if (clientThreadId && effectiveThreadId) {
    codexThreadMap.set(clientThreadId, effectiveThreadId);
  }

  return {
    ...summary,
    threadId: effectiveThreadId,
    resumed,
    localProvider,
    eventCount: codexResult.events.length,
    parseErrorCount: codexResult.parseErrors.length
  };
}

async function readWorkspaceFile(relativePath) {
  const absolutePath = resolveWorkspacePath(relativePath, { allowRoot: false });
  const stats = await fs.stat(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${relativePath}`);
  }

  if (stats.size > MAX_FILE_READ_BYTES) {
    throw new Error(`File too large to read in app (>${MAX_FILE_READ_BYTES} bytes)`);
  }

  const content = await fs.readFile(absolutePath, "utf8");
  return { path: toClientRelativePath(absolutePath), content };
}

async function writeWorkspaceFile(relativePath, content) {
  const absolutePath = resolveWorkspacePath(relativePath, { allowRoot: false });
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, String(content), "utf8");
  return {
    path: toClientRelativePath(absolutePath),
    bytesWritten: Buffer.byteLength(String(content), "utf8")
  };
}

async function listWorkspaceFiles(query, limit) {
  const files = [];
  await collectFilesRecursively(workspaceRoot, 0, files);

  const normalizedQuery = String(query || "").trim().toLowerCase();
  const maxItems = Math.max(1, Math.min(300, Number(limit) || 120));

  const filtered = normalizedQuery
    ? files.filter((file) => file.path.toLowerCase().includes(normalizedQuery))
    : files;

  return {
    count: filtered.length,
    files: filtered.slice(0, maxItems).map((file) => file.path)
  };
}

async function runShellInWorkspace(command, timeoutMs) {
  const commandText = String(command || "").trim();
  if (!commandText) {
    throw new Error("command is required");
  }

  if (/(^|\s)sudo(\s|$)/i.test(commandText) || /rm\s+-rf\s+\/(\s|$)/i.test(commandText)) {
    throw new Error("Blocked potentially destructive shell command");
  }

  const cappedTimeout = Math.max(1_000, Math.min(MAX_SHELL_TIMEOUT_MS, Number(timeoutMs) || 45_000));

  try {
    const { stdout, stderr } = await execFileAsync("/bin/zsh", ["-lc", commandText], {
      cwd: workspaceRoot,
      timeout: cappedTimeout,
      maxBuffer: 1024 * 1024 * 8
    });

    return {
      command: commandText,
      exitCode: 0,
      stdout: truncateText(stdout, MAX_SHELL_OUTPUT_CHARS),
      stderr: truncateText(stderr, MAX_SHELL_OUTPUT_CHARS)
    };
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const signal = typeof error?.signal === "string" ? error.signal : "";
    const code = typeof error?.code === "number" ? error.code : 1;
    return {
      command: commandText,
      exitCode: code,
      signal,
      stdout: truncateText(stdout, MAX_SHELL_OUTPUT_CHARS),
      stderr: truncateText(stderr || parseGitError(error), MAX_SHELL_OUTPUT_CHARS)
    };
  }
}

async function runAgentTool(tool, args) {
  const normalizedTool = String(tool || "");
  const normalizedArgs = args && typeof args === "object" ? args : {};

  if (normalizedTool === "list_files") {
    return await listWorkspaceFiles(normalizedArgs.query, normalizedArgs.limit);
  }

  if (normalizedTool === "read_file") {
    return await readWorkspaceFile(normalizedArgs.path);
  }

  if (normalizedTool === "write_file") {
    return await writeWorkspaceFile(normalizedArgs.path, normalizedArgs.content ?? "");
  }

  if (normalizedTool === "run_shell") {
    return await runShellInWorkspace(normalizedArgs.command, normalizedArgs.timeoutMs);
  }

  if (normalizedTool === "git_status") {
    const status = await runGit(["status", "--short", "--branch"], { timeout: 60_000 });
    return { output: truncateText(`${status.stdout}${status.stderr}`, MAX_AGENT_TOOL_RESULT_CHARS) };
  }

  if (normalizedTool === "git_diff") {
    const diffArgs = ["diff"];
    if (normalizedArgs.path) {
      diffArgs.push("--", String(normalizedArgs.path));
    }
    const diff = await runGit(diffArgs, { timeout: 60_000 });
    return { output: truncateText(`${diff.stdout}${diff.stderr}`, MAX_AGENT_TOOL_RESULT_CHARS) };
  }

  if (normalizedTool === "git_push") {
    const connection = await getGitConnection();
    if (!connection.connected || !connection.isGithub) {
      throw new Error(`GitHub push unavailable: ${connection.message}`);
    }
    const result = await runGit(["push", "--set-upstream", "origin", connection.branch], { timeout: 120_000 });
    return {
      branch: connection.branch,
      output: truncateText(`${result.stdout}${result.stderr}`, MAX_AGENT_TOOL_RESULT_CHARS)
    };
  }

  throw new Error(`Unknown tool: ${normalizedTool}`);
}

function compactToolResultForClient(tool, result) {
  if (!result || typeof result !== "object") {
    return result;
  }

  if (tool === "list_files") {
    return {
      count: result.count || 0,
      files: Array.isArray(result.files) ? result.files.slice(0, 20) : []
    };
  }

  if (tool === "read_file") {
    return {
      path: result.path || "",
      contentChars: typeof result.content === "string" ? result.content.length : 0
    };
  }

  if (tool === "run_shell") {
    return {
      command: result.command || "",
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      stdout: truncateText(result.stdout || "", 1200),
      stderr: truncateText(result.stderr || "", 1200)
    };
  }

  if (tool === "git_status" || tool === "git_diff" || tool === "git_push") {
    return {
      ...result,
      output: truncateText(result.output || "", 2000)
    };
  }

  return result;
}

function requestLikelyNeedsTools(messages) {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message?.role === "user" && typeof message?.content === "string");

  if (!lastUserMessage) {
    return false;
  }

  const text = String(lastUserMessage.content).toLowerCase();
  return /(read|open|show|inspect|review|summar|analy[sz]e|file|folder|directory|project|workspace|repo|repository|git|diff|status|run|shell|command|edit|change|fix|implement|write code|test|build)/.test(text);
}

function normalizeAgentToken(value) {
  const raw = String(value || "").toLowerCase();
  for (const name of AGENT_TOOL_NAMES) {
    if (raw.includes(name)) {
      return name;
    }
  }
  return raw.replace(/[^\w]+/g, "");
}

function pickBootstrapTool(messages) {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message?.role === "user" && typeof message?.content === "string");

  const text = String(lastUserMessage?.content || "");
  const lower = text.toLowerCase();

  if (/(git|commit|branch|push|diff|status)/.test(lower)) {
    if (/diff/.test(lower)) {
      return { tool: "git_diff", args: {} };
    }
    return { tool: "git_status", args: {} };
  }

  const pathMatch = text.match(/\b([A-Za-z0-9_./-]+\.[A-Za-z0-9_]+)\b/);
  if (pathMatch && /(read|open|show|summar|analy[sz]e|inspect|review)/.test(lower)) {
    return { tool: "read_file", args: { path: pathMatch[1] } };
  }

  if (/(file|folder|directory|project|workspace|repo|repository|list)/.test(lower)) {
    return { tool: "list_files", args: { limit: 20 } };
  }

  return null;
}

async function runAgentLoop({
  baseUrl,
  apiKey,
  model,
  messages,
  systemPrompt,
  thinking,
  maxTokens,
  maxSteps
}) {
  const steps = [];
  const cappedSteps = Math.max(1, Math.min(20, Number(maxSteps) || DEFAULT_AGENT_MAX_STEPS));
  const needsToolUse = requestLikelyNeedsTools(messages);
  let preferredModel = model;
  let fallbackModels = [];
  let modelPlan = null;

  if (isLikelyOllamaBaseUrl(baseUrl)) {
    const modelIds = await fetchModelCatalog(baseUrl, apiKey);
    const plan = buildOllamaModelPlan({
      prompt: getLastUserPrompt(messages),
      availableModelIds: modelIds,
      fallbackModel: model,
      agentMode: true
    });
    preferredModel = plan.preferredModel;
    fallbackModels = plan.fallbackModels;
    modelPlan = {
      taskType: plan.taskType,
      chainLabels: plan.chainLabels,
      resolvedChain: plan.resolvedChain
    };
  }

  const toolsSpec = [
    "list_files({query?, limit?})",
    "read_file({path})",
    "write_file({path, content})",
    "run_shell({command, timeoutMs?})",
    "git_status({})",
    "git_diff({path?})",
    "git_push({})"
  ].join(", ");

  const agentMessages = [
    {
      role: "system",
      content:
        "You are an autonomous coding agent. Run tools to complete the user's request.\n" +
        `Available tools: ${toolsSpec}\n` +
        "When the request refers to files, codebase state, shell commands, git, or verification, use tools instead of guessing.\n" +
        "You must respond with exactly one JSON object and no markdown.\n" +
        'Tool call format: {"type":"tool","tool":"read_file","args":{"path":"src/app.js"},"reason":"..."}\n' +
        'Final format: {"type":"final","content":"what you changed and outcome"}\n' +
        "Use one tool call per step. Prefer minimal, deterministic actions."
    },
    ...(systemPrompt ? [{ role: "system", content: `User system guidance:\n${systemPrompt}` }] : []),
    ...messages
  ];

  for (let stepIndex = 1; stepIndex <= cappedSteps; stepIndex += 1) {
    const modelReply = await callProviderChatWithFallback({
      baseUrl,
      apiKey,
      preferredModel,
      fallbackModels,
      messages: agentMessages,
      thinking,
      maxTokens
    });

    const action = extractJsonObject(modelReply.content);
    if (!action || typeof action !== "object") {
      return {
        content: modelReply.content,
        steps,
        completed: false,
        reason: "unstructured_response",
        modelPlan
      };
    }

    let actionType = normalizeAgentToken(action.type || action.action || "");
    let actionTool = normalizeAgentToken(action.tool || action.name || "");
    if (!actionType && actionTool) {
      actionType = "tool";
    }
    if (AGENT_TOOL_NAMES.has(actionType)) {
      if (!actionTool) {
        actionTool = actionType;
      }
      actionType = "tool";
    }

    if (actionType === "final") {
      if (needsToolUse && steps.length === 0 && stepIndex < cappedSteps) {
        const bootstrap = pickBootstrapTool(messages) || { tool: "list_files", args: { limit: 20 } };

        let bootstrapResult;
        try {
          bootstrapResult = await runAgentTool(bootstrap.tool, bootstrap.args);
        } catch (error) {
          bootstrapResult = {
            error: error instanceof Error ? error.message : String(error)
          };
        }

        steps.push({
          index: stepIndex,
          tool: bootstrap.tool,
          args: bootstrap.args,
          reason: "bootstrap_tool_enforcement",
          result: compactToolResultForClient(bootstrap.tool, bootstrapResult)
        });

        agentMessages.push({
          role: "assistant",
          content: JSON.stringify({
            type: "tool",
            tool: bootstrap.tool,
            args: bootstrap.args,
            reason: "bootstrap_tool_enforcement"
          })
        });
        agentMessages.push({
          role: "user",
          content:
            `Tool result for ${bootstrap.tool}:\n` +
            truncateText(JSON.stringify(bootstrapResult, null, 2), MAX_AGENT_TOOL_RESULT_CHARS)
        });
        continue;
      }

      const content = typeof action.content === "string"
        ? action.content
        : typeof action.summary === "string"
          ? action.summary
          : JSON.stringify(action);
      return { content, steps, completed: true, reason: "final", modelPlan };
    }

    if (actionType !== "tool") {
      return {
        content: `Agent returned unsupported action type: ${String(actionType || "unknown")}`,
        steps,
        completed: false,
        reason: "unsupported_action",
        modelPlan
      };
    }

    const tool = actionTool;
    const args = action.args && typeof action.args === "object" ? action.args : {};
    const reason = typeof action.reason === "string" ? action.reason : "";

    let result;
    try {
      result = await runAgentTool(tool, args);
    } catch (error) {
      result = {
        error: error instanceof Error ? error.message : String(error)
      };
    }

    steps.push({
      index: stepIndex,
      tool,
      args,
      reason,
      result: compactToolResultForClient(tool, result)
    });

    agentMessages.push({ role: "assistant", content: JSON.stringify(action) });
    agentMessages.push({
      role: "user",
      content:
        `Tool result for ${tool}:\n` +
        truncateText(JSON.stringify(result, null, 2), MAX_AGENT_TOOL_RESULT_CHARS)
    });
  }

  return {
    content: "Agent stopped after reaching the step limit.",
    steps,
    completed: false,
    reason: "max_steps",
    modelPlan
  };
}

app.get("/api/providers", (_req, res) => {
  res.json({
    providers,
    defaultProvider: "ollama",
    engine: VIBECODE_ENGINE,
    codexDefaultOssProvider: CODEX_OSS_PROVIDER || "ollama"
  });
});

app.get("/api/system/pick-folder", async (_req, res) => {
  try {
    const pickedPath = await chooseFolderOnMac(workspaceRoot);
    if (!pickedPath) {
      return res.status(400).json({ error: "No folder selected" });
    }
    return res.json({ path: path.resolve(pickedPath) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/user canceled|cancelled/i.test(message)) {
      return res.status(400).json({ error: "Folder selection cancelled" });
    }
    return res.status(500).json({ error: message });
  }
});

app.get("/api/workspace/info", async (_req, res) => {
  try {
    const info = await getWorkspaceInfo();
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/workspace/open", async (req, res) => {
  const { rootPath } = req.body || {};
  const candidate = String(rootPath || "").trim();
  if (!candidate) {
    return res.status(400).json({ error: "rootPath is required" });
  }

  try {
    const absolutePath = path.resolve(candidate);
    const stats = await fs.stat(absolutePath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: `Not a directory: ${absolutePath}` });
    }

    workspaceRoot = absolutePath;
    const info = await getWorkspaceInfo();
    return res.json(info);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/files/list", async (_req, res) => {
  try {
    const files = [];
    await collectFilesRecursively(workspaceRoot, 0, files);
    return res.json({ rootPath: workspaceRoot, files });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/files/read", async (req, res) => {
  const { path: inputPath } = req.query;
  if (!inputPath || typeof inputPath !== "string") {
    return res.status(400).json({ error: "path query parameter is required" });
  }

  try {
    const absolutePath = resolveWorkspacePath(inputPath, { allowRoot: false });
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return res.status(400).json({ error: `Not a file: ${inputPath}` });
    }

    if (stats.size > MAX_FILE_READ_BYTES) {
      return res.status(400).json({ error: `File too large to read in app (>${MAX_FILE_READ_BYTES} bytes)` });
    }

    const content = await fs.readFile(absolutePath, "utf8");
    return res.json({ path: toClientRelativePath(absolutePath), content });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/files/write", async (req, res) => {
  const { path: inputPath, content } = req.body || {};
  if (!inputPath || typeof inputPath !== "string") {
    return res.status(400).json({ error: "path is required" });
  }
  if (typeof content !== "string") {
    return res.status(400).json({ error: "content must be a string" });
  }

  try {
    const absolutePath = resolveWorkspacePath(inputPath, { allowRoot: false });
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    return res.json({
      path: toClientRelativePath(absolutePath),
      bytesWritten: Buffer.byteLength(content, "utf8")
    });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/git/summary", async (_req, res) => {
  try {
    const workspaceInfo = await getWorkspaceInfo();
    if (!workspaceInfo.isGitRepo) {
      return res.status(400).json({ error: "Workspace is not a git repository" });
    }

    const summary = await getDiffSummary();
    return res.json(summary);
  } catch (error) {
    return res.status(500).json({ error: parseGitError(error) });
  }
});

app.get("/api/git/connection", async (_req, res) => {
  try {
    const connection = await getGitConnection();
    res.json(connection);
  } catch (error) {
    res.status(500).json({ error: parseGitError(error) });
  }
});

app.post("/api/git/push", async (_req, res) => {
  try {
    const connection = await getGitConnection();
    if (!connection.connected) {
      return res.status(400).json({ error: `Git remote is not connected: ${connection.message}` });
    }

    if (!connection.isGithub) {
      return res.status(400).json({ error: `Origin remote is not a GitHub URL: ${connection.remoteUrl}` });
    }

    const result = await runGit(["push", "--set-upstream", "origin", connection.branch], { timeout: 120_000 });
    return res.json({
      branch: connection.branch,
      remoteUrl: connection.remoteUrl,
      workspaceRoot,
      output: `${result.stdout}${result.stderr}`.trim()
    });
  } catch (error) {
    return res.status(500).json({ error: parseGitError(error) });
  }
});

app.post("/api/models", async (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  if (!baseUrl) {
    return res.status(400).json({ error: "baseUrl is required" });
  }

  try {
    const modelIds = await fetchModelCatalog(baseUrl, apiKey, { force: true });
    const models = modelIds.map((id) => ({ id, owned_by: "unknown" }));

    return res.json({ models });
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 500;
    return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/route", async (req, res) => {
  const { prompt, routingRules, fallbackModel, baseUrl, apiKey, agentMode } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: "prompt is required" });
  }

  try {
    if (isLikelyOllamaBaseUrl(baseUrl)) {
      const modelIds = await fetchModelCatalog(baseUrl, apiKey);
      const plan = buildOllamaModelPlan({
        prompt,
        availableModelIds: modelIds,
        fallbackModel,
        agentMode: agentMode === true
      });

      if (!plan.preferredModel) {
        return res.status(400).json({
          error: "No Ollama model is available for this task. Pull a model first.",
          taskType: plan.taskType
        });
      }

      return res.json({
        taskType: plan.taskType,
        selectedModel: plan.preferredModel,
        fallbackModels: plan.fallbackModels,
        matchedRule: {
          source: "ollama_policy",
          chainLabels: plan.chainLabels,
          resolvedChain: plan.resolvedChain
        }
      });
    }

    const decision = pickModel(prompt, routingRules, fallbackModel);
    if (!decision.selectedModel) {
      return res.status(400).json({
        error: "No model matched this task. Add routing rules or choose a fallback model.",
        taskType: decision.taskType
      });
    }

    return res.json(decision);
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 500;
    return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/chat", async (req, res) => {
  const {
    baseUrl,
    apiKey,
    providerKey,
    clientThreadId,
    model,
    messages,
    systemPrompt,
    thinking,
    maxTokens
  } = req.body || {};

  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: "model and messages are required" });
  }

  if (shouldUseCodexRuntime(providerKey)) {
    try {
      const prompt = buildCodexPrompt({
        messages,
        systemPrompt,
        thinking
      });
      const result = await runCodexTurn({
        clientThreadId,
        providerKey,
        baseUrl,
        model,
        prompt,
        thinking
      });
      if (result.failureMessage) {
        return res.status(500).json({ error: result.failureMessage });
      }
      return res.json({
        content: result.content || "Codex completed without a final assistant message.",
        steps: result.steps,
        completed: true,
        reason: "codex_exec",
        threadId: result.threadId,
        resumed: result.resumed,
        localProvider: result.localProvider,
        eventCount: result.eventCount,
        parseErrorCount: result.parseErrorCount
      });
    } catch (error) {
      if (isCodexBinaryMissingError(error)) {
        console.warn(
          `[codex-oss-clone] codex binary not found (${CODEX_BIN}); falling back to provider runtime for /api/chat`
        );
      } else {
        const status = typeof error?.status === "number" ? error.status : 500;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  if (!baseUrl) {
    return res.status(400).json({ error: "baseUrl is required" });
  }

  const chatMessages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    ...messages
  ];
  try {
    let preferredModel = model;
    let fallbackModels = [];
    let modelPlan = null;

    if (isLikelyOllamaBaseUrl(baseUrl)) {
      const modelIds = await fetchModelCatalog(baseUrl, apiKey);
      const plan = buildOllamaModelPlan({
        prompt: getLastUserPrompt(chatMessages),
        availableModelIds: modelIds,
        fallbackModel: model,
        agentMode: false
      });
      preferredModel = plan.preferredModel;
      fallbackModels = plan.fallbackModels;
      modelPlan = {
        taskType: plan.taskType,
        chainLabels: plan.chainLabels,
        resolvedChain: plan.resolvedChain
      };
    }

    const response = await callProviderChatWithFallback({
      baseUrl,
      apiKey,
      preferredModel,
      fallbackModels,
      messages: chatMessages,
      thinking,
      maxTokens
    });
    return res.json({ ...response, modelPlan });
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 500;
    return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/agent", async (req, res) => {
  const {
    baseUrl,
    apiKey,
    providerKey,
    clientThreadId,
    model,
    messages,
    systemPrompt,
    thinking,
    maxTokens,
    maxSteps
  } = req.body || {};

  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: "model and messages are required" });
  }

  if (shouldUseCodexRuntime(providerKey)) {
    try {
      const prompt = buildCodexPrompt({
        messages,
        systemPrompt,
        thinking
      });
      const result = await runCodexTurn({
        clientThreadId,
        providerKey,
        baseUrl,
        model,
        prompt,
        thinking
      });
      if (result.failureMessage) {
        return res.status(500).json({ error: result.failureMessage });
      }
      return res.json({
        content: result.content || "Codex completed without a final assistant message.",
        steps: result.steps,
        completed: true,
        reason: "codex_exec",
        threadId: result.threadId,
        resumed: result.resumed,
        localProvider: result.localProvider,
        eventCount: result.eventCount,
        parseErrorCount: result.parseErrorCount
      });
    } catch (error) {
      if (isCodexBinaryMissingError(error)) {
        console.warn(
          `[codex-oss-clone] codex binary not found (${CODEX_BIN}); falling back to provider runtime for /api/agent`
        );
      } else {
        const status = typeof error?.status === "number" ? error.status : 500;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  if (!baseUrl) {
    return res.status(400).json({ error: "baseUrl is required" });
  }

  try {
    const result = await runAgentLoop({
      baseUrl,
      apiKey,
      model,
      messages,
      systemPrompt,
      thinking,
      maxTokens,
      maxSteps
    });

    return res.json(result);
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 500;
    return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => {
  console.log(`codex-oss-clone listening on http://localhost:${port} (workspace: ${workspaceRoot})`);
});
