const storageKey = "codex-oss-clone-settings-v5";
const taskTypes = ["coding", "reasoning", "writing", "summarization", "general"];
const deepClone = globalThis.structuredClone
  ? (value) => globalThis.structuredClone(value)
  : (value) => JSON.parse(JSON.stringify(value));

const defaultProjects = [
  {
    id: "codex-oss",
    name: "codex-for-open-source",
    threads: [
      { id: "fix-build", title: "Fix build", age: "8m" },
      { id: "alzer-1", title: "Plan Android and iOS apps", age: "5h" },
      { id: "alzer-2", title: "Fix profiles 401 errors", age: "19h" },
      { id: "alzer-3", title: "Require gender on profile upload", age: "21h" },
      { id: "alzer-4", title: "Add Sentry Cloudflare SDK", age: "22h" },
      { id: "alzer-5", title: "Find frontend and backend stack", age: "23h" }
    ]
  },
  {
    id: "kingedo",
    name: "Kingedo",
    threads: [
      { id: "kingedo-1", title: "Plan Android and iOS apps", age: "5h" },
      { id: "kingedo-2", title: "Use public display names", age: "17h" },
      { id: "kingedo-3", title: "Show public matchmaker names", age: "18h" }
    ]
  }
];

const state = {
  serverProvidersById: {},
  localBackendsById: {},
  providers: {},
  backendEngine: "provider",
  busy: false,
  defaultProvider: "ollama",
  agentMode: true,
  routingRules: taskTypes.map((taskType) => ({ taskType, modelId: "", enabled: true })),
  projects: deepClone(defaultProjects),
  projectExpandedById: {},
  activeThreadId: "fix-build",
  threadMessagesById: {},
  modelCatalogByProvider: {},
  selectedModelByProvider: {},
  baseUrlByProvider: {},
  apiKeyByProvider: {},
  gitConnection: null,
  workspaceRoot: "",
  workspaceIsGitRepo: false,
  workspaceBranch: "",
  workspaceFiles: [],
  selectedFilePath: ""
};

const freeProviderPriority = ["ollama", "localcli", "custom"];

const providerSelect = document.querySelector("#providerSelect");
const localBackendNameInput = document.querySelector("#localBackendNameInput");
const localBackendUrlInput = document.querySelector("#localBackendUrlInput");
const localBackendApiKeyInput = document.querySelector("#localBackendApiKeyInput");
const addLocalBackendButton = document.querySelector("#addLocalBackendButton");
const localBackendsList = document.querySelector("#localBackendsList");
const baseUrlInput = document.querySelector("#baseUrlInput");
const apiKeyInput = document.querySelector("#apiKeyInput");
const modelSelect = document.querySelector("#modelSelect");
const systemPromptInput = document.querySelector("#systemPromptInput");
const providerNotes = document.querySelector("#providerNotes");
const promptInput = document.querySelector("#promptInput");
const messagesEl = document.querySelector("#messages");
const statusPill = document.querySelector("#statusPill");
const activeModelLabel = document.querySelector("#activeModelLabel");
const sendButton = document.querySelector("#sendButton");
const template = document.querySelector("#messageTemplate");
const routingRulesEl = document.querySelector("#routingRules");
const settingsPanel = document.querySelector("#settingsPanel");
const settingsBackdrop = document.querySelector("#settingsBackdrop");
const toggleSettingsButton = document.querySelector("#toggleSettingsButton");
const closeSettingsButton = document.querySelector("#closeSettingsButton");
const projectsAccordionEl = document.querySelector("#projectsAccordion");
const openProjectFolderButton = document.querySelector("#openProjectFolderButton");
const openLocalFileButton = document.querySelector("#openLocalFileButton");
const localFilePicker = document.querySelector("#localFilePicker");
const threadTitleEl = document.querySelector("#threadTitle");
const repoLabelEl = document.querySelector("#repoLabel");
const searchInput = document.querySelector("#searchInput");
const thinkingSelect = document.querySelector("#thinkingSelect");
const agentModeToggle = document.querySelector("#agentModeToggle");
const diffBadge = document.querySelector("#diffBadge");
const pushGithubButton = document.querySelector("#pushGithubButton");
const githubStateEl = document.querySelector("#githubState");
const workspacePathInput = document.querySelector("#workspacePathInput");
const chooseWorkspaceFolderButton = document.querySelector("#chooseWorkspaceFolderButton");
const openWorkspaceButton = document.querySelector("#openWorkspaceButton");
const refreshFilesButton = document.querySelector("#refreshFilesButton");
const workspaceMetaEl = document.querySelector("#workspaceMeta");
const filePathInput = document.querySelector("#filePathInput");
const fileSelect = document.querySelector("#fileSelect");
const fileEditorInput = document.querySelector("#fileEditorInput");
const loadFileButton = document.querySelector("#loadFileButton");
const saveFileButton = document.querySelector("#saveFileButton");

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch {
    return {};
  }
}

function normalizeProviderKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createLocalBackendId(label) {
  const normalizedLabel = normalizeProviderKey(label);
  const seed = normalizedLabel || "backend";
  let candidate = `local-${seed}`;
  let suffix = 2;
  while (state.serverProvidersById[candidate] || state.localBackendsById[candidate]) {
    candidate = `local-${seed}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function syncProviderRegistry() {
  state.providers = {
    ...state.serverProvidersById,
    ...state.localBackendsById
  };
}

function renderProviderOptions(preferredProviderKey = null) {
  const selectedKey = preferredProviderKey || getCurrentProviderKey();
  providerSelect.innerHTML = "";

  for (const [providerKey, provider] of Object.entries(state.providers)) {
    const option = document.createElement("option");
    option.value = providerKey;
    option.textContent = provider.label;
    providerSelect.appendChild(option);
  }

  const fallbackProvider = getBestFreeProvider();
  providerSelect.value = state.providers[selectedKey]
    ? selectedKey
    : state.providers[fallbackProvider]
      ? fallbackProvider
      : Object.keys(state.providers)[0] || "";
}

function renderLocalBackends() {
  localBackendsList.innerHTML = "";
  const localBackendEntries = Object.entries(state.localBackendsById);

  if (!localBackendEntries.length) {
    const empty = document.createElement("div");
    empty.className = "local-backend-empty";
    empty.textContent = "No custom local backends yet.";
    localBackendsList.appendChild(empty);
    return;
  }

  for (const [providerKey, backend] of localBackendEntries) {
    const row = document.createElement("div");
    row.className = "local-backend-row";

    const meta = document.createElement("div");
    meta.className = "local-backend-meta";

    const name = document.createElement("div");
    name.className = "local-backend-name";
    name.textContent = backend.label;

    const url = document.createElement("div");
    url.className = "local-backend-url";
    url.textContent = backend.baseUrl;

    meta.append(name, url);

    const removeButton = document.createElement("button");
    removeButton.className = "mini-button";
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", async () => {
      delete state.localBackendsById[providerKey];
      delete state.baseUrlByProvider[providerKey];
      delete state.apiKeyByProvider[providerKey];
      delete state.modelCatalogByProvider[providerKey];
      delete state.selectedModelByProvider[providerKey];
      syncProviderRegistry();

      const nextProvider = state.providers[getCurrentProviderKey()] ? getCurrentProviderKey() : getBestFreeProvider();
      renderProviderOptions(nextProvider);
      renderLocalBackends();
      await handleProviderChange({ autoLoad: true });
      saveSettings("Local backend removed");
    });

    row.append(meta, removeButton);
    localBackendsList.appendChild(row);
  }
}

function getCurrentProviderKey() {
  return providerSelect.value || state.defaultProvider;
}

function getBestFreeProvider() {
  for (const key of freeProviderPriority) {
    if (state.providers[key]) {
      return key;
    }
  }

  return Object.keys(state.providers)[0] || "localcli";
}

function isFreeProviderKey(providerKey) {
  return freeProviderPriority.includes(providerKey) || String(providerKey || "").startsWith("local-");
}

function resolveProviderBaseUrl(providerKey) {
  return state.baseUrlByProvider[providerKey] ?? state.providers[providerKey]?.baseUrl ?? "";
}

function resolveProviderApiKey(providerKey) {
  return (state.apiKeyByProvider[providerKey] ?? state.providers[providerKey]?.apiKey ?? "").trim();
}

async function addLocalBackend() {
  const label = localBackendNameInput.value.trim();
  const baseUrl = localBackendUrlInput.value.trim();
  const apiKey = localBackendApiKeyInput.value;

  if (!baseUrl) {
    setStatus("Backend URL required");
    return;
  }

  try {
    const parsed = new URL(baseUrl);
    if (!/^https?:$/i.test(parsed.protocol)) {
      throw new Error("URL must start with http:// or https://");
    }
  } catch {
    setStatus("Invalid backend URL");
    return;
  }

  const providerId = createLocalBackendId(label || baseUrl);
  state.localBackendsById[providerId] = {
    label: label || `Local backend ${Object.keys(state.localBackendsById).length + 1}`,
    baseUrl,
    apiKey,
    notes: "User-added local OpenAI-compatible endpoint."
  };
  state.baseUrlByProvider[providerId] = baseUrl;
  state.apiKeyByProvider[providerId] = apiKey;
  state.modelCatalogByProvider[providerId] = [];
  state.selectedModelByProvider[providerId] = "";

  syncProviderRegistry();
  renderProviderOptions(providerId);
  renderLocalBackends();
  await handleProviderChange({ autoLoad: true });

  localBackendNameInput.value = "";
  localBackendUrlInput.value = "";
  localBackendApiKeyInput.value = "";
  saveSettings("Local backend added");
}

function isLikelyLocalBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function providerNeedsApiKey(providerKey, baseUrl) {
  if (providerKey === "ollama") {
    return false;
  }
  if (isLikelyLocalBaseUrl(baseUrl)) {
    return false;
  }
  return true;
}

function ensureProviderAuth(providerKey, actionLabel) {
  const baseUrl = resolveProviderBaseUrl(providerKey).trim();
  const apiKey = resolveProviderApiKey(providerKey).trim();
  if (!providerNeedsApiKey(providerKey, baseUrl) || apiKey) {
    return true;
  }

  const providerLabel = state.providers[providerKey]?.label || providerKey;
  setSettingsOpen(true);
  setStatus("API key required");
  addMessage("assistant", `Set an API key for ${providerLabel} in Settings before ${actionLabel}.`, {
    meta: "auth",
    internal: true
  });
  apiKeyInput.focus();
  return false;
}

function basenameFromPath(pathValue) {
  if (!pathValue) {
    return "workspace";
  }
  const chunks = pathValue.replace(/\\/g, "/").split("/").filter(Boolean);
  return chunks[chunks.length - 1] || pathValue;
}

function getSettingsPayload() {
  return {
    provider: getCurrentProviderKey(),
    thinking: thinkingSelect.value,
    agentMode: state.agentMode,
    systemPrompt: systemPromptInput.value,
    routingRules: state.routingRules,
    projects: state.projects,
    activeThreadId: state.activeThreadId,
    threadMessagesById: state.threadMessagesById,
    projectExpandedById: state.projectExpandedById,
    modelCatalogByProvider: state.modelCatalogByProvider,
    selectedModelByProvider: state.selectedModelByProvider,
    baseUrlByProvider: state.baseUrlByProvider,
    apiKeyByProvider: state.apiKeyByProvider,
    localBackendsById: state.localBackendsById,
    workspaceRoot: state.workspaceRoot,
    selectedFilePath: state.selectedFilePath
  };
}

function saveSettings(statusText = null) {
  localStorage.setItem(storageKey, JSON.stringify(getSettingsPayload()));
  if (statusText) {
    setStatus(statusText);
  }
  syncActiveModelLabel();
}

function setStatus(text) {
  statusPill.textContent = text;
  statusPill.classList.toggle("error", /fail|error|invalid|missing|not connected|blocked/i.test(text));
}

function isSettingsOpen() {
  return document.body.classList.contains("settings-open");
}

function setSettingsOpen(open) {
  document.body.classList.toggle("settings-open", open);
  settingsPanel.setAttribute("aria-hidden", open ? "false" : "true");
  settingsBackdrop.setAttribute("aria-hidden", open ? "false" : "true");
}

function syncActiveModelLabel() {
  const model = state.selectedModelByProvider[getCurrentProviderKey()] || "no model";
  const fileBit = state.selectedFilePath ? ` · file ${state.selectedFilePath}` : "";
  const modeBit = state.agentMode ? "agent on" : "agent off";
  activeModelLabel.textContent = `${model} · thinking ${thinkingSelect.value} · ${modeBit}${fileBit}`;
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ensureThreadMessages(threadId) {
  if (!threadId) {
    return [];
  }

  if (!Array.isArray(state.threadMessagesById[threadId])) {
    state.threadMessagesById[threadId] = [];
  }

  return state.threadMessagesById[threadId];
}

function getActiveThreadMessages() {
  return ensureThreadMessages(state.activeThreadId);
}

function renderMessages() {
  const activeMessages = getActiveThreadMessages();
  document.body.classList.toggle("has-messages", activeMessages.length > 0);
  messagesEl.innerHTML = "";

  if (!activeMessages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<div style=\"font-size:40px; line-height:1; margin-bottom:10px;\">☁︎</div><div style=\"font-size:44px; color:#1f1f24; font-weight:600; letter-spacing:-0.02em;\">Let’s build</div><div style=\"font-size:44px; color:#8f8f99; letter-spacing:-0.02em;\">New project</div>";
    messagesEl.appendChild(empty);
    return;
  }

  for (const message of activeMessages) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.add(message.role);
    if (message.internal) {
      node.classList.add("internal");
    }
    node.querySelector(".message-role").textContent = message.role;
    node.querySelector(".message-meta").textContent = message.meta || "";
    node.querySelector(".message-content").textContent = message.content;
    messagesEl.appendChild(node);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, content, options = {}) {
  getActiveThreadMessages().push({
    role,
    content,
    meta: options.meta || timestamp(),
    internal: options.internal === true
  });
  renderMessages();
}

function setBusy(busy) {
  state.busy = busy;
  sendButton.disabled = busy;
  sendButton.textContent = busy ? "Running" : "Go";
}

function findThread(threadId) {
  for (const project of state.projects) {
    for (const thread of project.threads) {
      if (thread.id === threadId) {
        return thread;
      }
    }
  }
  return null;
}

function findProjectById(projectId) {
  return state.projects.find((project) => project.id === projectId) || null;
}

function ensureActiveThread() {
  const active = findThread(state.activeThreadId);
  if (active) {
    ensureThreadMessages(active.id);
    return active;
  }

  const fallback = state.projects[0]?.threads[0] || null;
  state.activeThreadId = fallback?.id || "";
  if (fallback) {
    ensureThreadMessages(fallback.id);
  }
  return fallback;
}

function openThread(threadId, statusText = null) {
  const thread = findThread(threadId);
  if (!thread) {
    return;
  }

  state.activeThreadId = thread.id;
  ensureThreadMessages(thread.id);
  threadTitleEl.textContent = thread.title;
  renderProjects();
  renderMessages();
  promptInput.focus();
  saveSettings(statusText || `Opened ${thread.title}`);
}

function createNewChat(projectId = null) {
  const now = new Date();
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const nextThread = {
    id: `thread-${now.getTime()}`,
    title: "New chat",
    age: `${now.getHours()}:${minutes}`
  };

  let project = projectId ? findProjectById(projectId) : state.projects[0] || null;
  if (!project) {
    project = { id: "default", name: "Default", threads: [] };
    state.projects.push(project);
  }

  project.threads.unshift(nextThread);
  state.projectExpandedById[project.id] = true;
  state.threadMessagesById[nextThread.id] = [];
  openThread(nextThread.id, `New chat in ${project.name}`);
}

function renderProjects() {
  const search = searchInput.value.trim().toLowerCase();
  projectsAccordionEl.innerHTML = "";

  for (const project of state.projects) {
    const expanded = state.projectExpandedById[project.id] !== false;
    const group = document.createElement("section");
    group.className = "project-group";
    if (!expanded) {
      group.classList.add("collapsed");
    }

    const header = document.createElement("div");
    header.className = "project-header";

    const toggleButton = document.createElement("button");
    toggleButton.className = "project-toggle-button";
    toggleButton.type = "button";

    const label = document.createElement("span");
    label.textContent = `▭ ${project.name}`;

    const chevron = document.createElement("span");
    chevron.className = "project-chevron";
    chevron.textContent = "▾";

    toggleButton.append(label, chevron);
    toggleButton.addEventListener("click", () => {
      state.projectExpandedById[project.id] = !expanded;
      renderProjects();
      saveSettings("Folder updated");
    });

    const newChatButton = document.createElement("button");
    newChatButton.className = "project-add-chat-button";
    newChatButton.type = "button";
    newChatButton.title = `New chat in ${project.name}`;
    newChatButton.setAttribute("aria-label", `New chat in ${project.name}`);
    newChatButton.textContent = "+";
    newChatButton.addEventListener("click", (event) => {
      event.stopPropagation();
      createNewChat(project.id);
    });

    header.append(toggleButton, newChatButton);

    const body = document.createElement("div");
    body.className = "project-threads";

    const matchingThreads = project.threads.filter((thread) => {
      if (!search) {
        return true;
      }
      return thread.title.toLowerCase().includes(search);
    });

    if (!matchingThreads.length) {
      const empty = document.createElement("div");
      empty.className = "project-empty";
      empty.textContent = search ? "No matching threads" : "No threads";
      body.appendChild(empty);
    } else {
      for (const thread of matchingThreads) {
        const row = document.createElement("div");
        row.className = "thread-item";
        if (thread.id === state.activeThreadId) {
          row.classList.add("active");
        }

        const title = document.createElement("span");
        title.textContent = thread.title;

        const age = document.createElement("span");
        age.className = "thread-time";
        age.textContent = thread.age;

        row.append(title, age);
        row.addEventListener("click", () => {
          openThread(thread.id);
        });

        body.appendChild(row);
      }
    }

    group.append(header, body);
    projectsAccordionEl.appendChild(group);
  }
}

function applyModelsToSelect(providerKey) {
  const models = state.modelCatalogByProvider[providerKey] || [];
  const selected = state.selectedModelByProvider[providerKey] || "";

  modelSelect.innerHTML = "";

  if (!models.length) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "No models loaded";
    modelSelect.appendChild(placeholder);
    state.selectedModelByProvider[providerKey] = "";
    syncActiveModelLabel();
    renderRoutingRules();
    return;
  }

  for (const modelId of models) {
    const option = document.createElement("option");
    option.value = modelId;
    option.textContent = modelId;
    modelSelect.appendChild(option);
  }

  const finalSelection = models.includes(selected) ? selected : models[0];
  modelSelect.value = finalSelection;
  state.selectedModelByProvider[providerKey] = finalSelection;

  syncActiveModelLabel();
  renderRoutingRules();
}

function normalizeRelativeFilePath(pathValue) {
  return String(pathValue || "").trim().replace(/^\/+/, "");
}

function renderFileList() {
  fileSelect.innerHTML = "";

  if (!state.workspaceFiles.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No files indexed";
    fileSelect.appendChild(empty);
    return;
  }

  for (const file of state.workspaceFiles) {
    const option = document.createElement("option");
    option.value = file.path;
    option.textContent = file.path;
    fileSelect.appendChild(option);
  }

  if (state.selectedFilePath && state.workspaceFiles.some((file) => file.path === state.selectedFilePath)) {
    fileSelect.value = state.selectedFilePath;
  }
}

function updateWorkspaceMeta(info) {
  state.workspaceRoot = info.rootPath;
  state.workspaceIsGitRepo = info.isGitRepo;
  state.workspaceBranch = info.branch || "";
  workspacePathInput.value = info.rootPath || "";
  repoLabelEl.textContent = basenameFromPath(info.rootPath || "workspace");

  const gitInfo = info.isGitRepo
    ? `git repo${info.branch ? ` (${info.branch})` : ""}`
    : "not a git repo";
  workspaceMetaEl.textContent = `${info.rootPath} · ${gitInfo}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "Invalid JSON response" }));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload;
}

async function refreshWorkspaceInfo() {
  const data = await fetchJson("/api/workspace/info");
  updateWorkspaceMeta(data);
  return data;
}

async function openWorkspace() {
  const rootPath = workspacePathInput.value.trim();
  if (!rootPath) {
    setStatus("Workspace path required");
    return;
  }

  setStatus("Opening workspace...");
  try {
    const data = await fetchJson("/api/workspace/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath })
    });

    updateWorkspaceMeta(data);
    await refreshFiles({ quiet: true });
    await refreshGitSummary();
    await refreshGitConnection();
    saveSettings("Workspace opened");
  } catch (error) {
    setStatus("Workspace open failed");
    addMessage("assistant", `Workspace open failed: ${error.message}`, {
      meta: "workspace",
      internal: true
    });
  }
}

async function chooseWorkspaceFolder() {
  setStatus("Opening folder picker...");
  try {
    const data = await fetchJson("/api/system/pick-folder");
    workspacePathInput.value = data.path;
    await openWorkspace();
  } catch (error) {
    setStatus("Folder picker cancelled");
    if (!/cancelled/i.test(error.message)) {
      addMessage("assistant", `Could not choose folder: ${error.message}`, {
        meta: "workspace",
        internal: true
      });
    }
  }
}

async function refreshFiles({ quiet = false } = {}) {
  if (!quiet) {
    setStatus("Refreshing files...");
  }

  try {
    const data = await fetchJson("/api/files/list");
    state.workspaceFiles = data.files || [];
    renderFileList();
    if (!quiet) {
      setStatus(`Indexed ${state.workspaceFiles.length} files`);
    }
  } catch (error) {
    if (!quiet) {
      setStatus("File index failed");
      addMessage("assistant", `File indexing failed: ${error.message}`, {
        meta: "workspace",
        internal: true
      });
    }
  }
}

async function loadFile(pathOverride = null) {
  const rawPath = pathOverride || filePathInput.value || fileSelect.value;
  const relativePath = normalizeRelativeFilePath(rawPath);
  if (!relativePath) {
    setStatus("File path required");
    return;
  }

  setStatus(`Loading ${relativePath}...`);
  try {
    const data = await fetchJson(`/api/files/read?path=${encodeURIComponent(relativePath)}`);
    state.selectedFilePath = data.path;
    filePathInput.value = data.path;
    fileEditorInput.value = data.content;

    if (state.workspaceFiles.some((file) => file.path === data.path)) {
      fileSelect.value = data.path;
    }

    syncActiveModelLabel();
    saveSettings(`Loaded ${data.path}`);
  } catch (error) {
    setStatus("File load failed");
    addMessage("assistant", `Could not load file: ${error.message}`, {
      meta: "workspace",
      internal: true
    });
  }
}

async function saveCurrentFile() {
  const relativePath = normalizeRelativeFilePath(filePathInput.value || state.selectedFilePath);
  if (!relativePath) {
    setStatus("File path required");
    return;
  }

  setStatus(`Saving ${relativePath}...`);
  try {
    const data = await fetchJson("/api/files/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: relativePath,
        content: fileEditorInput.value
      })
    });

    state.selectedFilePath = data.path;
    filePathInput.value = data.path;
    await refreshFiles({ quiet: true });
    if (state.workspaceFiles.some((file) => file.path === data.path)) {
      fileSelect.value = data.path;
    }

    syncActiveModelLabel();
    saveSettings(`Saved ${data.path}`);
    await refreshGitSummary();
  } catch (error) {
    setStatus("File save failed");
    addMessage("assistant", `Could not save file: ${error.message}`, {
      meta: "workspace",
      internal: true
    });
  }
}

function buildWorkspaceContext() {
  const selectedPath = normalizeRelativeFilePath(state.selectedFilePath || filePathInput.value);
  const content = fileEditorInput.value;
  if (!selectedPath || !content.trim()) {
    return "";
  }

  const maxChars = 12000;
  const limited = content.length > maxChars ? `${content.slice(0, maxChars)}\n...[truncated]` : content;
  return `Workspace file context:\nPath: ${selectedPath}\n\n${limited}`;
}

function ensureRule(taskType) {
  let rule = state.routingRules.find((entry) => entry.taskType === taskType);
  if (!rule) {
    rule = { taskType, modelId: "", enabled: true };
    state.routingRules.push(rule);
  }
  return rule;
}

function renderRoutingRules() {
  routingRulesEl.innerHTML = "";

  for (const taskType of taskTypes) {
    const rule = ensureRule(taskType);
    const row = document.createElement("div");
    row.className = "routing-rule";

    const label = document.createElement("div");
    label.className = "rule-label";
    label.textContent = taskType;

    const select = document.createElement("select");
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "Use fallback";
    select.appendChild(emptyOption);

    for (const option of modelSelect.options) {
      if (!option.value) {
        continue;
      }
      const clone = document.createElement("option");
      clone.value = option.value;
      clone.textContent = option.value;
      select.appendChild(clone);
    }

    select.value = rule.modelId || "";
    select.addEventListener("change", () => {
      rule.modelId = select.value;
      saveSettings("Routing updated");
    });

    const toggle = document.createElement("label");
    toggle.className = "rule-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = rule.enabled !== false;
    checkbox.addEventListener("change", () => {
      rule.enabled = checkbox.checked;
      saveSettings("Routing updated");
    });
    toggle.append(checkbox, document.createTextNode("On"));

    row.append(label, select, toggle);
    routingRulesEl.append(row);
  }
}

function summarizeAgentStep(step) {
  const tool = step?.tool || "unknown_tool";
  const result = step?.result || {};
  const args = step?.args || {};

  if (tool === "read_file") {
    return `read_file: ${result.path || args.path || "unknown"} (${(result.content || "").length} chars)`;
  }

  if (tool === "write_file") {
    return `write_file: ${result.path || args.path || "unknown"} (${result.bytesWritten || 0} bytes)`;
  }

  if (tool === "list_files") {
    return `list_files: ${result.count || 0} file(s)`;
  }

  if (tool === "run_shell") {
    const code = typeof result.exitCode === "number" ? result.exitCode : "n/a";
    return `run_shell: exit ${code} · ${args.command || ""}`;
  }

  if (tool === "git_status") {
    return "git_status";
  }

  if (tool === "git_diff") {
    return `git_diff: ${args.path || "workspace"}`;
  }

  if (tool === "git_push") {
    return "git_push";
  }

  if (tool === "web_search") {
    return `web_search: ${args.query || "query"}`;
  }

  if (typeof tool === "string" && tool.startsWith("mcp:")) {
    const status = result?.status || "unknown";
    return `${tool}: ${status}`;
  }

  return `${tool}`;
}

function renderGitConnection(connection) {
  githubStateEl.classList.remove("connected", "disconnected");

  if (!connection) {
    githubStateEl.textContent = "GitHub: unknown";
    githubStateEl.classList.add("disconnected");
    return;
  }

  if (connection.connected && connection.isGithub) {
    githubStateEl.textContent = `GitHub: connected (${connection.branch})`;
    githubStateEl.classList.add("connected");
    return;
  }

  if (connection.connected && !connection.isGithub) {
    githubStateEl.textContent = `Remote: connected (${connection.branch})`;
    githubStateEl.classList.add("disconnected");
    return;
  }

  githubStateEl.textContent = "GitHub: not connected";
  githubStateEl.classList.add("disconnected");
}

async function refreshGitSummary() {
  try {
    const data = await fetchJson("/api/git/summary");
    diffBadge.textContent = `+${data.added} -${data.removed}`;
    diffBadge.style.color = data.added || data.removed ? "#bbf7d0" : "#c9ced8";
  } catch {
    diffBadge.textContent = "+0 -0";
  }
}

async function refreshGitConnection() {
  try {
    const data = await fetchJson("/api/git/connection");
    state.gitConnection = data;
    renderGitConnection(data);
    return data;
  } catch (error) {
    state.gitConnection = {
      connected: false,
      isGithub: false,
      branch: "unknown",
      remoteUrl: "unknown",
      message: error.message
    };
    renderGitConnection(state.gitConnection);
    return state.gitConnection;
  }
}

async function pushToGithub() {
  const connection = await refreshGitConnection();
  if (!connection.connected || !connection.isGithub) {
    setStatus("GitHub not connected");
    addMessage("assistant", "Push blocked: remote is not connected to GitHub credentials.", {
      meta: connection.remoteUrl || "git",
      internal: true
    });
    return;
  }

  setStatus("Pushing to GitHub...");
  pushGithubButton.disabled = true;

  try {
    const data = await fetchJson("/api/git/push", { method: "POST" });
    setStatus(`Pushed ${data.branch}`);
    addMessage("assistant", `Git push complete on branch ${data.branch}.`, {
      meta: "git",
      internal: true
    });
    await refreshGitSummary();
    await refreshGitConnection();
  } catch (error) {
    setStatus("Push failed");
    addMessage("assistant", `Git push failed: ${error.message}`, {
      meta: "git",
      internal: true
    });
  } finally {
    pushGithubButton.disabled = false;
  }
}

async function loadModels(options = {}) {
  const providerKey = options.providerKey || getCurrentProviderKey();
  const quiet = options.quiet === true;

  const baseUrl = resolveProviderBaseUrl(providerKey);
  const apiKey = resolveProviderApiKey(providerKey);

  if (!ensureProviderAuth(providerKey, "loading models")) {
    return;
  }

  if (!baseUrl) {
    if (!quiet) {
      setStatus("Model load failed");
      addMessage("assistant", "Cannot load models: base URL is missing for this provider.", {
        meta: providerKey,
        internal: true
      });
    }
    return;
  }

  if (!quiet) {
    setStatus("Loading models...");
  }

  try {
    const data = await fetchJson("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl,
        apiKey
      })
    });

    const models = data.models.map((item) => item.id);
    state.modelCatalogByProvider[providerKey] = models;

    const currentSelection = state.selectedModelByProvider[providerKey];
    if (!models.length) {
      state.selectedModelByProvider[providerKey] = "";
    } else if (!currentSelection || !models.includes(currentSelection)) {
      state.selectedModelByProvider[providerKey] = models[0];
    }

    if (providerKey === getCurrentProviderKey()) {
      applyModelsToSelect(providerKey);
    }

    saveSettings(quiet ? null : `Loaded ${models.length} model${models.length === 1 ? "" : "s"}`);
  } catch (error) {
    if (!quiet) {
      setStatus("Model load failed");
      addMessage("assistant", `Could not load models: ${error.message}`, {
        meta: providerKey,
        internal: true
      });
    }
  }
}

async function handleProviderChange({ autoLoad = true } = {}) {
  const providerKey = getCurrentProviderKey();
  baseUrlInput.value = resolveProviderBaseUrl(providerKey);
  apiKeyInput.value = resolveProviderApiKey(providerKey);
  providerNotes.textContent = state.providers[providerKey]?.notes || "";

  if (!state.modelCatalogByProvider[providerKey]) {
    state.modelCatalogByProvider[providerKey] = [];
  }

  applyModelsToSelect(providerKey);

  if (autoLoad && state.modelCatalogByProvider[providerKey].length === 0 && baseUrlInput.value.trim()) {
    await loadModels({ providerKey, quiet: true });
    applyModelsToSelect(providerKey);
  }

  syncActiveModelLabel();
  saveSettings("Provider changed");
}

async function sendMessage() {
  if (state.busy) {
    return;
  }

  const content = promptInput.value.trim();
  if (!content) {
    return;
  }

  const providerKey = getCurrentProviderKey();
  const selectedModel = state.selectedModelByProvider[providerKey] || "";
  const workspaceContext = buildWorkspaceContext();

  if (state.backendEngine !== "codex" && !ensureProviderAuth(providerKey, "sending a chat request")) {
    return;
  }

  setBusy(true);
  addMessage("user", content);
  promptInput.value = "";
  setStatus("Routing task...");

  try {
    const routingDecision = await fetchJson("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: content,
        routingRules: state.routingRules,
        fallbackModel: selectedModel,
        baseUrl: resolveProviderBaseUrl(providerKey),
        apiKey: resolveProviderApiKey(providerKey),
        agentMode: state.agentMode
      })
    });

    const routeModel = routingDecision.selectedModel;
    const fallbackModels = Array.isArray(routingDecision.fallbackModels) ? routingDecision.fallbackModels : [];
    const routeMeta = `task ${routingDecision.taskType} · model ${routeModel} · thinking ${thinkingSelect.value}`;
    const fallbackMeta = fallbackModels.length ? ` → fallback ${fallbackModels.join(" -> ")}` : "";

    addMessage("assistant", `Router selected ${routeModel} for ${routingDecision.taskType}${fallbackMeta}.`, {
      meta: routingDecision.matchedRule ? "matched routing rule" : "used fallback model",
      internal: true
    });

    setStatus(`Running ${routeModel}...`);

    const chatMessages = getActiveThreadMessages()
      .filter((message) => (message.role === "user" || message.role === "assistant") && !message.internal)
      .map(({ role, content: messageContent }) => ({ role, content: messageContent }));

    const requestMessages = workspaceContext
      ? [...chatMessages, { role: "system", content: workspaceContext }]
      : chatMessages;

    const endpoint = state.agentMode ? "/api/agent" : "/api/chat";
    const data = await fetchJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerKey,
        clientThreadId: state.activeThreadId,
        baseUrl: resolveProviderBaseUrl(providerKey),
        apiKey: resolveProviderApiKey(providerKey),
        model: routeModel,
        thinking: thinkingSelect.value,
        systemPrompt: systemPromptInput.value,
        messages: requestMessages,
        maxSteps: 8
      })
    });

    if (Array.isArray(data.steps) && data.steps.length > 0) {
      for (const step of data.steps) {
        addMessage("assistant", summarizeAgentStep(step), {
          meta: `agent step ${step.index}`,
          internal: true
        });
      }
    }

    if (state.backendEngine === "codex" && data.threadId) {
      addMessage(
        "assistant",
        `Codex thread ${data.threadId}${data.resumed ? " resumed" : " started"} (${data.localProvider || "oss"}).`,
        {
          meta: "codex runtime",
          internal: true
        }
      );
    }

    addMessage("assistant", data.content, { meta: routeMeta });
    setStatus(state.agentMode ? "Agent run complete" : "Ready");
    saveSettings();
    await refreshGitSummary();
  } catch (error) {
    addMessage("assistant", `Request failed: ${error.message}`, {
      meta: "runtime error",
      internal: true
    });
    setStatus("Request failed");
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
  document.querySelectorAll(".starter-card").forEach((card) => {
    card.addEventListener("click", () => {
      promptInput.value = card.textContent.trim();
      promptInput.focus();
    });
  });

  providerSelect.addEventListener("change", async () => {
    await handleProviderChange({ autoLoad: true });
  });

  addLocalBackendButton.addEventListener("click", addLocalBackend);
  localBackendNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addLocalBackend();
    }
  });
  localBackendUrlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addLocalBackend();
    }
  });
  localBackendApiKeyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addLocalBackend();
    }
  });

  modelSelect.addEventListener("change", () => {
    state.selectedModelByProvider[getCurrentProviderKey()] = modelSelect.value;
    syncActiveModelLabel();
    renderRoutingRules();
    saveSettings("Model selected");
  });

  thinkingSelect.addEventListener("change", () => {
    syncActiveModelLabel();
    saveSettings("Thinking updated");
  });

  agentModeToggle.addEventListener("change", () => {
    state.agentMode = agentModeToggle.checked;
    syncActiveModelLabel();
    saveSettings(state.agentMode ? "Agent mode enabled" : "Agent mode disabled");
  });

  systemPromptInput.addEventListener("change", () => saveSettings("System prompt saved"));

  baseUrlInput.addEventListener("change", () => {
    state.baseUrlByProvider[getCurrentProviderKey()] = baseUrlInput.value.trim();
    saveSettings("Base URL saved");
  });

  apiKeyInput.addEventListener("change", () => {
    state.apiKeyByProvider[getCurrentProviderKey()] = apiKeyInput.value;
    saveSettings("API key saved");
  });

  document.querySelector("#saveSettingsButton").addEventListener("click", () => saveSettings("Settings saved"));
  document.querySelector("#loadModelsButton").addEventListener("click", () => loadModels({ providerKey: getCurrentProviderKey(), quiet: false }));
  document.querySelector("#sendButton").addEventListener("click", sendMessage);

  document.querySelector("#newChatButton").addEventListener("click", () => {
    createNewChat();
  });

  searchInput.addEventListener("input", renderProjects);

  openProjectFolderButton.addEventListener("click", chooseWorkspaceFolder);
  openLocalFileButton.addEventListener("click", () => {
    localFilePicker.click();
  });

  localFilePicker.addEventListener("change", async () => {
    const [file] = localFilePicker.files || [];
    if (!file) {
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setStatus("File too large");
      addMessage("assistant", "Open file failed: file is larger than 2MB.", {
        meta: "workspace",
        internal: true
      });
      localFilePicker.value = "";
      return;
    }

    try {
      const text = await file.text();
      const suggestedPath = normalizeRelativeFilePath(file.name || "new-file.txt");
      state.selectedFilePath = suggestedPath;
      filePathInput.value = suggestedPath;
      fileEditorInput.value = text;
      setSettingsOpen(true);
      syncActiveModelLabel();
      saveSettings(`Opened local file ${suggestedPath}`);
    } catch (error) {
      setStatus("Open file failed");
      addMessage("assistant", `Could not open local file: ${error.message}`, {
        meta: "workspace",
        internal: true
      });
    } finally {
      localFilePicker.value = "";
    }
  });

  promptInput.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      sendMessage();
    }
  });

  toggleSettingsButton.addEventListener("click", () => {
    const open = !isSettingsOpen();
    setSettingsOpen(open);
    setStatus(open ? "Settings shown" : "Settings hidden");
  });

  closeSettingsButton.addEventListener("click", () => {
    setSettingsOpen(false);
    setStatus("Settings hidden");
  });

  settingsBackdrop.addEventListener("click", () => {
    setSettingsOpen(false);
    setStatus("Settings hidden");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isSettingsOpen()) {
      setSettingsOpen(false);
      setStatus("Settings hidden");
    }
  });

  pushGithubButton.addEventListener("click", pushToGithub);

  chooseWorkspaceFolderButton.addEventListener("click", chooseWorkspaceFolder);
  openWorkspaceButton.addEventListener("click", openWorkspace);
  refreshFilesButton.addEventListener("click", () => refreshFiles({ quiet: false }));
  loadFileButton.addEventListener("click", () => loadFile());
  saveFileButton.addEventListener("click", saveCurrentFile);

  fileSelect.addEventListener("change", () => {
    const selected = normalizeRelativeFilePath(fileSelect.value);
    if (!selected) {
      return;
    }
    filePathInput.value = selected;
    state.selectedFilePath = selected;
    syncActiveModelLabel();
    saveSettings();
  });

  fileSelect.addEventListener("dblclick", () => {
    const selected = normalizeRelativeFilePath(fileSelect.value);
    if (selected) {
      loadFile(selected);
    }
  });

  filePathInput.addEventListener("change", () => {
    state.selectedFilePath = normalizeRelativeFilePath(filePathInput.value);
    syncActiveModelLabel();
    saveSettings();
  });
}

function applyLoadedSettings(settings) {
  if (Array.isArray(settings.projects) && settings.projects.length > 0) {
    state.projects = settings.projects;
  }

  state.threadMessagesById = typeof settings.threadMessagesById === "object" && settings.threadMessagesById
    ? settings.threadMessagesById
    : {};

  state.projectExpandedById = typeof settings.projectExpandedById === "object" && settings.projectExpandedById
    ? settings.projectExpandedById
    : {};

  for (const project of state.projects) {
    if (!(project.id in state.projectExpandedById)) {
      state.projectExpandedById[project.id] = true;
    }
  }

  state.activeThreadId = settings.activeThreadId || state.activeThreadId;
  ensureActiveThread();

  state.modelCatalogByProvider = typeof settings.modelCatalogByProvider === "object" && settings.modelCatalogByProvider
    ? settings.modelCatalogByProvider
    : {};

  state.selectedModelByProvider = typeof settings.selectedModelByProvider === "object" && settings.selectedModelByProvider
    ? settings.selectedModelByProvider
    : {};

  state.baseUrlByProvider = typeof settings.baseUrlByProvider === "object" && settings.baseUrlByProvider
    ? settings.baseUrlByProvider
    : {};

  state.apiKeyByProvider = typeof settings.apiKeyByProvider === "object" && settings.apiKeyByProvider
    ? settings.apiKeyByProvider
    : {};

  const loadedLocalBackends = typeof settings.localBackendsById === "object" && settings.localBackendsById
    ? settings.localBackendsById
    : {};
  state.localBackendsById = {};
  for (const [providerKey, backend] of Object.entries(loadedLocalBackends)) {
    const normalizedKey = normalizeProviderKey(providerKey);
    const finalProviderKey = normalizedKey.startsWith("local-") ? normalizedKey : `local-${normalizedKey}`;
    const label = String(backend?.label || "").trim();
    const baseUrl = String(backend?.baseUrl || "").trim();
    if (!label || !baseUrl) {
      continue;
    }
    state.localBackendsById[finalProviderKey] = {
      label,
      baseUrl,
      apiKey: String(backend?.apiKey || ""),
      notes: String(backend?.notes || "User-added local OpenAI-compatible endpoint.")
    };
  }
  syncProviderRegistry();

  state.routingRules = Array.isArray(settings.routingRules) && settings.routingRules.length
    ? settings.routingRules
    : state.routingRules;

  state.workspaceRoot = settings.workspaceRoot || state.workspaceRoot;
  state.selectedFilePath = settings.selectedFilePath || state.selectedFilePath;

  if (settings.baseUrl && !state.baseUrlByProvider[state.defaultProvider]) {
    state.baseUrlByProvider[state.defaultProvider] = settings.baseUrl;
  }

  if (settings.apiKey && !state.apiKeyByProvider[state.defaultProvider]) {
    state.apiKeyByProvider[state.defaultProvider] = settings.apiKey;
  }

  if (settings.model && !state.selectedModelByProvider[state.defaultProvider]) {
    state.selectedModelByProvider[state.defaultProvider] = settings.model;
    state.modelCatalogByProvider[state.defaultProvider] = [settings.model];
  }

  if (Array.isArray(settings.messages) && settings.messages.length) {
    const activeThreadId = state.activeThreadId || state.projects[0]?.threads[0]?.id;
    if (activeThreadId && !state.threadMessagesById[activeThreadId]?.length) {
      state.threadMessagesById[activeThreadId] = settings.messages;
    }
  }

  for (const project of state.projects) {
    for (const thread of project.threads) {
      ensureThreadMessages(thread.id);
    }
  }

  systemPromptInput.value = settings.systemPrompt || systemPromptInput.value;
  thinkingSelect.value = settings.thinking || "medium";
  state.agentMode = typeof settings.agentMode === "boolean" ? settings.agentMode : true;
  agentModeToggle.checked = state.agentMode;
}

async function init() {
  const providersData = await fetchJson("/api/providers");
  state.serverProvidersById = providersData.providers || {};
  syncProviderRegistry();
  state.defaultProvider = providersData.defaultProvider || "ollama";
  state.backendEngine = providersData.engine || "provider";

  const settings = loadSettings();
  applyLoadedSettings(settings);

  const bestFreeProvider = getBestFreeProvider();
  const storedProvider = settings.provider;
  renderProviderOptions(isFreeProviderKey(storedProvider) && state.providers[storedProvider]
    ? storedProvider
    : bestFreeProvider);

  const active = ensureActiveThread();
  threadTitleEl.textContent = active?.title || "New chat";

  bindEvents();
  setSettingsOpen(false);
  renderLocalBackends();
  renderProjects();
  renderRoutingRules();
  renderMessages();

  const preferredWorkspaceRoot = state.workspaceRoot;
  await refreshWorkspaceInfo();
  if (preferredWorkspaceRoot && preferredWorkspaceRoot !== workspacePathInput.value) {
    workspacePathInput.value = preferredWorkspaceRoot;
    await openWorkspace();
  }
  await refreshFiles({ quiet: true });

  if (state.selectedFilePath) {
    filePathInput.value = state.selectedFilePath;
    if (state.workspaceFiles.some((file) => file.path === state.selectedFilePath)) {
      fileSelect.value = state.selectedFilePath;
    }
  }

  await handleProviderChange({ autoLoad: true });
  await refreshGitSummary();
  await refreshGitConnection();
  if (state.backendEngine === "codex") {
    setStatus("Ready (Codex engine)");
  }
  promptInput.focus();
}

init().catch((error) => {
  setStatus("Init failed");
  addMessage("assistant", `Startup failed: ${error.message}`, {
    meta: "bootstrap error",
    internal: true
  });
});
