import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { constants, watch, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type {
  AppState,
  ApplyResult,
  CapabilityAgentId,
  CapabilityApplyResult,
  LocalCapability,
  ModelListResult,
  ProviderProfile,
  ToolTarget
} from '../shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const defaultGlobalPrompt = 'You are a pragmatic coding agent. Prefer direct execution, concise updates, and verified results.';
const fileWatchers = new Map<string, { watcher: FSWatcher; debounce?: NodeJS.Timeout }>();
const environmentCache = new Map<string, string | undefined>();
const legacyCodexConfigPath = '%USERPROFILE%/.codex/config.toml';
const legacyCodexPromptPath = '%USERPROFILE%/.codex/AGENTS.md';
const managedBlockStart = '# >>> Agent Router managed';
const managedBlockEnd = '# <<< Agent Router managed';
const capabilityBlockStart = '# >>> Agent Router capabilities';
const capabilityBlockEnd = '# <<< Agent Router capabilities';
const claudeCodeModelOptions = ['default', 'best', 'fable', 'opus', 'sonnet', 'haiku', 'sonnet[1m]', 'opus[1m]', 'opusplan', 'opusplan[1m]'];
const claudeCodeModelOptionSet = new Set(claudeCodeModelOptions);
const claudeCodeEffortOptions = ['', 'auto', 'low', 'medium', 'high'];

type LegacyAppState = Partial<AppState> & {
  activeProviderId?: string;
  globalPrompt?: string;
  providers?: Partial<ProviderProfile>[];
};

const defaultProviders: ProviderProfile[] = [
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      defaultModel: 'gpt-5',
      note: 'For Codex or OpenAI-compatible tools.'
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
      defaultModel: 'sonnet',
      note: 'For Claude Code or Anthropic-compatible gateways.'
    },
    {
      id: 'gemini',
      name: 'Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: '',
      defaultModel: 'gemini-2.5-pro',
      note: 'For Gemini CLI or Gemini-compatible gateways.'
    }
];

function cloneDefaultProviders(): ProviderProfile[] {
  return defaultProviders.map((provider) => ({ ...provider }));
}

const defaultState: AppState = {
  capabilities: [],
  targets: [
    {
      id: 'codex',
      name: 'Codex',
      enabled: true,
      activeProviderId: 'openai',
      providers: cloneDefaultProviders(),
      globalPrompt: defaultGlobalPrompt,
      globalPromptEnabled: true,
      globalTemplate: '',
      globalTemplateEnabled: true,
      promptFilePath: legacyCodexPromptPath,
      filePath: legacyCodexConfigPath,
      backupRetention: 3,
      note: 'Codex provider key is written directly into config.toml as api_key.',
      template: [
        '# Managed by Agent Router',
        'model = "{{provider.defaultModel}}"',
        'model_provider = "agent-router"',
        '{{provider.reasoningEffortConfig}}',
        '{{provider.contextWindowConfig}}',
        '',
        '[model_providers.agent-router]',
        'name = "{{provider.name}}"',
        'base_url = "{{provider.baseUrl}}"',
        'api_key = "{{provider.apiKey}}"',
        '',
        '{{globalTemplate}}'
      ].join('\n')
    },
    {
      id: 'claude',
      name: 'Claude Code',
      enabled: true,
      activeProviderId: 'anthropic',
      providers: cloneDefaultProviders(),
      globalPrompt: defaultGlobalPrompt,
      globalPromptEnabled: true,
      globalTemplate: '',
      globalTemplateEnabled: true,
      promptFilePath: '%USERPROFILE%/.claude/CLAUDE.md',
      filePath: '%USERPROFILE%/.claude/settings.json',
      backupRetention: 3,
      note: 'Starter JSON template using environment-style fields.',
      template: '{{claudeSettingsJson}}'
    },
    {
      id: 'gemini',
      name: 'Gemini',
      enabled: true,
      activeProviderId: 'gemini',
      providers: cloneDefaultProviders(),
      globalPrompt: defaultGlobalPrompt,
      globalPromptEnabled: true,
      globalTemplate: '',
      globalTemplateEnabled: true,
      promptFilePath: '%USERPROFILE%/.gemini/GEMINI.md',
      filePath: '%USERPROFILE%/.gemini/settings.json',
      backupRetention: 3,
      note: 'Starter JSON template for Gemini-compatible clients.',
      template: [
        '{',
        '  "apiEndpoint": {{json.provider.baseUrl}},',
        '  "apiKey": {{json.provider.apiKey}},',
        '  "model": {',
        '    "name": {{json.provider.defaultModel}}',
        '  }',
        '{{globalTemplate}}',
        '}'
      ].join('\n')
    }
  ]
};

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: 'Agent Router',
    backgroundColor: '#f5f2ec',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'state.json');
}

async function loadState(): Promise<AppState> {
  try {
    const raw = await readFile(storePath(), 'utf8');
    return hydratePromptsFromFiles(normalizeState(JSON.parse(raw)));
  } catch {
    await saveState(defaultState);
    return hydratePromptsFromFiles(defaultState);
  }
}

async function saveState(state: AppState): Promise<AppState> {
  const normalized = normalizeState(state);
  await mkdir(path.dirname(storePath()), { recursive: true });
  await writeFile(storePath(), JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function normalizeState(input: LegacyAppState): AppState {
  const legacyProviders = Array.isArray(input.providers) && input.providers.length > 0
    ? input.providers.map(normalizeProvider)
    : undefined;
  const legacyActiveProviderId = legacyProviders?.some((provider) => provider.id === input.activeProviderId)
    ? String(input.activeProviderId)
    : legacyProviders?.[0]?.id;

  return {
    targets: normalizeTargets(input.targets, legacyProviders, legacyActiveProviderId, input.globalPrompt),
    capabilities: normalizeCapabilities(input.capabilities)
  };
}

function normalizeCapabilities(capabilities: unknown): LocalCapability[] {
  if (!Array.isArray(capabilities)) {
    return [];
  }
  return capabilities
    .filter(isRecord)
    .map((capability) => {
      const kind = capability.kind === 'skill' ? 'skill' : 'plugin';
      const agent = normalizeCapabilityAgent(capability.agent);
      return {
        id: String(capability.id || `${agent}:${kind}:${capability.path || capability.name || crypto.randomUUID()}`),
        kind,
        agent,
        name: String(capability.name || capability.displayName || 'local-capability'),
        displayName: String(capability.displayName || capability.name || 'Local capability'),
        version: String(capability.version || ''),
        marketplace: capability.marketplace ? String(capability.marketplace) : undefined,
        path: String(capability.path || ''),
        description: capability.description ? String(capability.description) : '',
        enabledTargets: Array.isArray(capability.enabledTargets)
          ? capability.enabledTargets.filter((target): target is CapabilityAgentId => target === 'codex' || target === 'claude' || target === 'gemini')
          : []
      };
    });
}

function normalizeCapabilityAgent(value: unknown): CapabilityAgentId {
  return value === 'claude' || value === 'gemini' ? value : 'codex';
}

function normalizeProvider(provider: Partial<ProviderProfile>): ProviderProfile {
  return {
    id: stableId(provider.id || provider.name || 'provider'),
    name: String(provider.name || 'Provider'),
    baseUrl: String(provider.baseUrl || ''),
    apiKey: String(provider.apiKey || ''),
    defaultModel: normalizeDefaultModel(provider),
    modelOptions: normalizeModelOptions(provider),
    smallFastModel: String(provider.smallFastModel || ''),
    claudeDefaultSonnetModel: String(provider.claudeDefaultSonnetModel || ''),
    claudeDefaultOpusModel: String(provider.claudeDefaultOpusModel || ''),
    claudeDefaultHaikuModel: String(provider.claudeDefaultHaikuModel || ''),
    claudeDefaultFableModel: String(provider.claudeDefaultFableModel || ''),
    effortLevel: normalizeClaudeCodeEffort(provider.effortLevel),
    reasoningEffort: normalizeReasoningEffort(provider.reasoningEffort),
    millionContextEnabled: Boolean(provider.millionContextEnabled),
    note: provider.note ? String(provider.note) : ''
  };
}

function normalizeTargets(
  targets: Partial<ToolTarget>[] | undefined,
  legacyProviders?: ProviderProfile[],
  legacyActiveProviderId?: string,
  legacyGlobalPrompt?: string
): ToolTarget[] {
  const targetMap = new Map((Array.isArray(targets) ? targets : []).map((target) => [stableId(target.id || target.name || 'target'), target]));
  return defaultState.targets.map((defaultTarget) =>
    normalizeTarget(targetMap.get(defaultTarget.id) || defaultTarget, legacyProviders, legacyActiveProviderId, legacyGlobalPrompt)
  );
}

function normalizeTarget(
  target: Partial<ToolTarget>,
  legacyProviders?: ProviderProfile[],
  legacyActiveProviderId?: string,
  legacyGlobalPrompt?: string
): ToolTarget {
  const id = stableId(target.id || target.name || 'target');
  const defaultTarget = defaultState.targets.find((item) => item.id === id);
  const rawTemplate = String(target.template ?? defaultTarget?.template ?? '');
  const shouldUpgradeTemplate = shouldUpgradeDefaultTemplate(id, rawTemplate);
  const template = shouldUpgradeTemplate && defaultTarget ? defaultTarget.template : rawTemplate;
  const providers = Array.isArray(target.providers) && target.providers.length > 0
    ? target.providers.map(normalizeProvider)
    : legacyProviders || defaultTarget?.providers.map(normalizeProvider) || cloneDefaultProviders();
  const normalizedProviders = id === 'claude'
    ? providers.map(normalizeClaudeCodeProvider)
    : providers;
  const activeProviderId = providers.some((provider) => provider.id === target.activeProviderId)
    ? String(target.activeProviderId)
    : providers.some((provider) => provider.id === legacyActiveProviderId)
      ? String(legacyActiveProviderId)
      : providers.some((provider) => provider.id === defaultTarget?.activeProviderId)
        ? String(defaultTarget?.activeProviderId)
        : providers[0].id;
  const appliedProviderId = normalizedProviders.some((provider) => provider.id === target.appliedProviderId)
    ? String(target.appliedProviderId)
    : activeProviderId;

  return {
    id,
    name: String(target.name || defaultTarget?.name || 'Target'),
    enabled: target.enabled ?? defaultTarget?.enabled ?? false,
    activeProviderId,
    appliedProviderId,
    providers: normalizedProviders,
    globalPrompt: String(target.globalPrompt ?? legacyGlobalPrompt ?? defaultTarget?.globalPrompt ?? defaultGlobalPrompt),
    globalPromptEnabled: target.globalPromptEnabled ?? defaultTarget?.globalPromptEnabled ?? true,
    globalTemplate: String(target.globalTemplate ?? defaultTarget?.globalTemplate ?? ''),
    globalTemplateEnabled: target.globalTemplateEnabled ?? defaultTarget?.globalTemplateEnabled ?? true,
    promptFilePath: String(target.promptFilePath || defaultTarget?.promptFilePath || ''),
    filePath: String(target.filePath || defaultTarget?.filePath || ''),
    template,
    backupRetention: normalizeBackupRetention(target.backupRetention ?? defaultTarget?.backupRetention ?? 3),
    note: String(target.note || defaultTarget?.note || '')
  };
}

async function hydratePromptsFromFiles(state: AppState): Promise<AppState> {
  const targets = await Promise.all(state.targets.map(async (target) => {
    if (!target.promptFilePath?.trim()) {
      return target;
    }

    try {
      const prompt = await readFile(resolveTargetPromptPath(target), 'utf8');
      return { ...target, globalPrompt: prompt };
    } catch {
      return target;
    }
  }));
  return { ...state, targets };
}

function normalizeBackupRetention(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 3;
  }
  return Math.max(0, Math.min(50, Math.floor(parsed)));
}

function isLegacyCodexTemplate(template: string): boolean {
  return template.includes('[model_providers.active]') ||
    template.includes('env_key = "OPENAI_API_KEY"') ||
    template.includes('env_key = "{{target.envVarName}}"');
}

function shouldUpgradeDefaultTemplate(id: string, template: string): boolean {
  if (id === 'codex' && isLegacyCodexTemplate(template)) {
    return true;
  }
  if (
    id === 'codex' &&
    template.includes('# Managed by Agent Router') &&
    template.includes('[model_providers.agent-router]') &&
    (!template.includes('{{provider.reasoningEffortConfig}}') || !template.includes('{{provider.contextWindowConfig}}'))
  ) {
    return true;
  }
  if (
    id === 'claude' &&
    template.includes('"ANTHROPIC_BASE_URL"')
  ) {
    return true;
  }
  if (id === 'claude' && !template.includes('{{claudeSettingsJson}}')) {
    return true;
  }
  return !template.includes('{{globalTemplate}}') && (
    template.includes('instructions = {{json.globalPrompt}}') ||
    template.includes('"globalPrompt": {{json.globalPrompt}}')
  );
}

function normalizeReasoningEffort(value: unknown): string {
  const effort = String(value || '').trim();
  return ['', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : '';
}

function normalizeClaudeCodeEffort(value: unknown): string {
  const effort = String(value || '').trim();
  return claudeCodeEffortOptions.includes(effort) ? effort : '';
}

function normalizeDefaultModel(provider: Partial<ProviderProfile>): string {
  const model = String(provider.defaultModel || '');
  return model === 'claude-sonnet-4-5' ? 'sonnet' : model;
}

function normalizeModelOptions(provider: Partial<ProviderProfile>): string[] {
  const options = Array.isArray(provider.modelOptions)
    ? provider.modelOptions.map((model) => String(model).trim()).filter(Boolean)
    : [];
  const isAnthropicProvider = provider.id === 'anthropic' || String(provider.name || '').toLowerCase().includes('anthropic');
  if (!isAnthropicProvider) {
    return [...new Set(options)];
  }
  return [...new Set(options.filter((model) => !claudeCodeModelOptionSet.has(model)))];
}

function normalizeClaudeCodeProvider(provider: ProviderProfile): ProviderProfile {
  return {
    ...provider,
    defaultModel: provider.defaultModel || 'sonnet',
    modelOptions: [...new Set((provider.modelOptions || []).filter((model) => !claudeCodeModelOptionSet.has(model)))],
    smallFastModel: provider.smallFastModel || 'haiku',
    effortLevel: normalizeClaudeCodeEffort(provider.effortLevel)
  };
}

function stableId(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || crypto.randomUUID();
}

function expandConfigPath(filePath: string): string {
  let expanded = filePath.trim();
  expanded = expanded.replace(/^~(?=$|[/\\])/, os.homedir());
  for (let pass = 0; pass < 2; pass += 1) {
    expanded = expanded.replace(/%([^%]+)%/g, (_, name: string) => environmentValue(name) || '');
    expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => environmentValue(name) || '');
  }
  return path.resolve(expanded);
}

function codexHomePath(): string {
  const configured = environmentValue('CODEX_HOME')?.trim();
  return configured ? expandConfigPath(configured) : path.join(os.homedir(), '.codex');
}

function environmentValue(name: string): string | undefined {
  const directValue = process.env[name]?.trim();
  if (directValue) {
    return directValue;
  }

  const normalizedName = name.toUpperCase();
  const matchingProcessEntry = Object.entries(process.env).find(
    ([key, value]) => key.toUpperCase() === normalizedName && Boolean(value?.trim())
  );
  if (matchingProcessEntry?.[1]) {
    return matchingProcessEntry[1].trim();
  }

  if (process.platform !== 'win32') {
    return undefined;
  }
  if (environmentCache.has(normalizedName)) {
    return environmentCache.get(normalizedName);
  }

  const registryValue = readWindowsEnvironmentValue(name);
  environmentCache.set(normalizedName, registryValue);
  return registryValue;
}

function readWindowsEnvironmentValue(name: string): string | undefined {
  const roots = [
    'HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  ];

  for (const root of roots) {
    try {
      const output = execFileSync('reg', ['query', root, '/v', name], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      });
      const value = parseWindowsRegistryValue(decodeCommandOutput(output), name);
      if (value) {
        return value;
      }
    } catch {
      // Missing registry values are expected on many machines.
    }
  }

  return undefined;
}

function decodeCommandOutput(output: Buffer): string {
  const utf16 = output.toString('utf16le');
  return utf16.includes('REG_') ? utf16 : output.toString('utf8');
}

function parseWindowsRegistryValue(output: string, name: string): string | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(name)}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'im');
  return pattern.exec(output)?.[1]?.trim();
}

function isDefaultCodexPath(filePath: string, expectedFilename: string): boolean {
  const rawPath = filePath.trim().replace(/\\/g, '/').toLowerCase();
  const legacyPath = `%USERPROFILE%/.codex/${expectedFilename}`.toLowerCase();
  if (rawPath === legacyPath) {
    return true;
  }

  try {
    const oldDefaultPath = path.join(os.homedir(), '.codex', expectedFilename);
    return path.normalize(expandConfigPath(filePath)).toLowerCase() === path.normalize(oldDefaultPath).toLowerCase();
  } catch {
    return false;
  }
}

function resolveKnownDefaultPath(filePath: string): string {
  if (isDefaultCodexPath(filePath, 'config.toml')) {
    return path.join(codexHomePath(), 'config.toml');
  }
  if (isDefaultCodexPath(filePath, 'AGENTS.md')) {
    return path.join(codexHomePath(), 'AGENTS.md');
  }
  return expandConfigPath(filePath);
}

function resolveTargetConfigPath(target: ToolTarget): string {
  if (target.id === 'codex' && isDefaultCodexPath(target.filePath, 'config.toml')) {
    return path.join(codexHomePath(), 'config.toml');
  }
  return expandConfigPath(target.filePath);
}

function resolveTargetPromptPath(target: ToolTarget): string {
  const promptFilePath = target.promptFilePath || '';
  if (target.id === 'codex' && isDefaultCodexPath(promptFilePath, 'AGENTS.md')) {
    return path.join(codexHomePath(), 'AGENTS.md');
  }
  return expandConfigPath(promptFilePath);
}

async function applyTarget(target: ToolTarget, state: AppState): Promise<ApplyResult> {
  const provider = target.providers.find((item) => item.id === target.activeProviderId);
  if (!provider) {
    throw new Error(`${target.name} has no active provider selected.`);
  }
  if (!target.filePath.trim()) {
    throw new Error(`${target.name} has no target file path.`);
  }

  const resolvedPath = resolveTargetConfigPath(target);
  const rendered = renderTemplate(target.template, state, provider, target);
  const content = target.id === 'codex'
    ? await mergeManagedCodexConfig(resolvedPath, rendered)
    : rendered;
  const written = await writeRenderedFile(resolvedPath, content, target.backupRetention);
  const promptFilePath = target.promptFilePath?.trim();
  const promptWritten = target.globalPromptEnabled !== false && promptFilePath
    ? await writeRenderedFile(resolveTargetPromptPath(target), target.globalPrompt || '', target.backupRetention)
    : undefined;

  return {
    targetId: target.id,
    targetName: target.name,
    filePath: written.filePath,
    backupPath: written.backupPath,
    bytes: written.bytes,
    promptFilePath: promptWritten?.filePath,
    promptBackupPath: promptWritten?.backupPath,
    promptBytes: promptWritten?.bytes
  };
}

async function writeRenderedFile(filePath: string, content: string, backupRetention = 3): Promise<{ filePath: string; backupPath?: string; bytes: number }> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const retention = normalizeBackupRetention(backupRetention);
  const backupPath = retention > 0 ? await backupIfExists(filePath) : undefined;
  await writeFile(filePath, content, 'utf8');
  await pruneBackups(filePath, retention);
  return {
    filePath,
    backupPath,
    bytes: Buffer.byteLength(content, 'utf8')
  };
}

async function mergeManagedCodexConfig(filePath: string, rendered: string): Promise<string> {
  try {
    const existing = await readFile(filePath, 'utf8');
    return mergeManagedConfig(existing, rendered);
  } catch {
    return buildManagedBlock(rendered);
  }
}

function mergeManagedConfig(existing: string, rendered: string): string {
  const block = buildManagedBlock(rendered);
  const startIndex = existing.indexOf(managedBlockStart);
  const endIndex = existing.indexOf(managedBlockEnd);

  if (startIndex >= 0 && endIndex > startIndex) {
    const endLineIndex = existing.indexOf('\n', endIndex);
    const replaceEnd = endLineIndex >= 0 ? endLineIndex + 1 : existing.length;
    return `${existing.slice(0, startIndex)}${block}${existing.slice(replaceEnd)}`;
  }

  const preserved = stripLegacyManagedConfig(existing, rendered).trimEnd();
  return preserved ? `${preserved}\n\n${block}` : block;
}

function buildManagedBlock(content: string): string {
  const normalized = content
    .replace(new RegExp(`^${escapeRegExp(managedBlockStart)}\\r?\\n?`, 'm'), '')
    .replace(new RegExp(`^${escapeRegExp(managedBlockEnd)}\\r?\\n?`, 'm'), '')
    .trimEnd();
  return `${managedBlockStart}\n${normalized}\n${managedBlockEnd}\n`;
}

function stripLegacyManagedConfig(existing: string, rendered: string): string {
  const managedKeys = collectTopLevelKeys(rendered);
  const managedTables = collectTables(rendered);
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let skipManagedTable = false;
  let inTable = false;

  for (const line of lines) {
    const tableName = parseTableName(line);
    if (tableName) {
      skipManagedTable = managedTables.has(tableName);
      inTable = !skipManagedTable;
      if (!skipManagedTable) {
        kept.push(line);
      }
      continue;
    }

    if (skipManagedTable) {
      continue;
    }

    if (!inTable) {
      const key = parseTopLevelKey(line);
      if (key && managedKeys.has(key)) {
        continue;
      }
      if (line.trim() === '# Managed by Agent Router') {
        continue;
      }
    }

    kept.push(line);
  }

  return kept.join('\n');
}

function collectTopLevelKeys(content: string): Set<string> {
  const keys = new Set<string>();
  let inTable = false;

  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    if (parseTableName(line)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      continue;
    }
    const key = parseTopLevelKey(line);
    if (key) {
      keys.add(key);
    }
  }

  return keys;
}

function collectTables(content: string): Set<string> {
  const tables = new Set<string>();
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const tableName = parseTableName(line);
    if (tableName) {
      tables.add(tableName);
    }
  }
  return tables;
}

function parseTableName(line: string): string | undefined {
  const match = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
  return match?.[1].trim();
}

function parseTopLevelKey(line: string): string | undefined {
  const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
  return match?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pruneBackups(filePath: string, retention: number): Promise<void> {
  const dir = path.dirname(filePath);
  const backupPrefix = `${path.basename(filePath)}.bak-`;
  const entries = await readdir(dir, { withFileTypes: true });
  const backups = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(backupPrefix))
    .map((entry) => path.join(dir, entry.name))
    .sort()
    .reverse();

  const staleBackups = backups.slice(retention);
  for (const backup of staleBackups) {
    await unlink(backup);
  }
}

async function backupIfExists(filePath: string): Promise<string | undefined> {
  try {
    await access(filePath, constants.F_OK);
  } catch {
    return undefined;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.bak-${stamp}`;
  await copyFile(filePath, backupPath);
  return backupPath;
}

async function watchTargetFile(
  webContentsId: number,
  watchId: string,
  filePath: string,
  emit: (payload: { watchId: string; filePath: string; content: string; error?: string }) => void
): Promise<{ watchId: string; filePath: string; content: string; error?: string }> {
  closeTargetWatcher(webContentsId, watchId);

  const resolvedPath = resolveKnownDefaultPath(filePath);
  const initial = { watchId, ...(await readWatchedFile(resolvedPath)) };
  const dir = path.dirname(resolvedPath);
  const basename = path.basename(resolvedPath);
  const watcherKey = targetWatcherKey(webContentsId, watchId);

  try {
    await stat(dir);
    const watcher = watch(dir, (eventType, changedName) => {
      if (changedName && changedName.toString() !== basename) {
        return;
      }

      const existing = fileWatchers.get(watcherKey);
      if (!existing) {
        return;
      }
      if (existing.debounce) {
        clearTimeout(existing.debounce);
      }
      existing.debounce = setTimeout(async () => {
        emit({ watchId, ...(await readWatchedFile(resolvedPath)) });
      }, 120);
    });

    fileWatchers.set(watcherKey, { watcher });
  } catch {
    fileWatchers.delete(watcherKey);
  }

  return initial;
}

async function readWatchedFile(filePath: string): Promise<{ filePath: string; content: string; error?: string }> {
  try {
    return {
      filePath,
      content: await readFile(filePath, 'utf8')
    };
  } catch (error) {
    return {
      filePath,
      content: '',
      error: error instanceof Error ? error.message : '读取失败'
    };
  }
}

function targetWatcherKey(webContentsId: number, watchId: string): string {
  return `${webContentsId}:${watchId}`;
}

function closeTargetWatcher(webContentsId: number, watchId: string): void {
  const key = targetWatcherKey(webContentsId, watchId);
  const existing = fileWatchers.get(key);
  if (!existing) {
    return;
  }
  if (existing.debounce) {
    clearTimeout(existing.debounce);
  }
  existing.watcher.close();
  fileWatchers.delete(key);
}

function closeAllTargetWatchers(webContentsId: number): void {
  for (const key of [...fileWatchers.keys()]) {
    if (!key.startsWith(`${webContentsId}:`)) {
      continue;
    }
    const existing = fileWatchers.get(key);
    if (existing?.debounce) {
      clearTimeout(existing.debounce);
    }
    existing?.watcher.close();
    fileWatchers.delete(key);
  }
}

function renderTemplate(template: string, state: AppState, provider: ProviderProfile, target?: ToolTarget): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, token: string) => {
    const key = token.trim();
    if (key === 'claudeSettingsJson') {
      return renderClaudeSettingsJson(provider, target);
    }
    if (key === 'globalTemplate') {
      return target?.globalTemplateEnabled !== false && target?.globalTemplate
        ? renderTemplate(target.globalTemplate, state, provider, target)
        : '';
    }
    if (key.startsWith('json.')) {
      return JSON.stringify(valueForToken(key.slice(5), state, provider, target));
    }
    return String(valueForToken(key, state, provider, target) ?? '');
  });
}

function valueForToken(token: string, state: AppState, provider: ProviderProfile, target?: ToolTarget): unknown {
  const reasoningEffort = normalizeReasoningEffort(provider.reasoningEffort);
  const claudeCodeModel = provider.defaultModel || 'sonnet';
  const smallFastModel = provider.smallFastModel || 'haiku';
  const values: Record<string, unknown> = {
    isoDate: new Date().toISOString(),
    globalPrompt: target?.globalPrompt || '',
    'provider.id': provider.id,
    'provider.name': provider.name,
    'provider.baseUrl': provider.baseUrl,
    'provider.apiKey': provider.apiKey,
    'provider.defaultModel': provider.defaultModel,
    'provider.smallFastModel': smallFastModel,
    'provider.disableNonessentialModelCalls': '1',
    'provider.effortLevel': normalizeClaudeCodeEffort(provider.effortLevel) || 'auto',
    'provider.claudeCodeModel': claudeCodeModel,
    'provider.claudeCodeEnvOverrides': renderClaudeCodeEnvOverrides(provider, claudeCodeModel, smallFastModel),
    'provider.reasoningEffort': reasoningEffort,
    'provider.reasoningEffortConfig': reasoningEffort ? `model_reasoning_effort = "${reasoningEffort}"` : '',
    'provider.contextWindowConfig': provider.millionContextEnabled ? 'model_context_window = 1000000' : '',
    'provider.note': provider.note || '',
    'target.id': target?.id || '',
    'target.name': target?.name || '',
    'target.filePath': target?.filePath || '',
    'target.globalPrompt': target?.globalPrompt || '',
    'target.globalTemplate': target?.globalTemplate || '',
    'target.note': target?.note || ''
  };
  return values[token] ?? '';
}

function renderClaudeSettingsJson(provider: ProviderProfile, target?: ToolTarget): string {
  const claudeCodeModel = provider.defaultModel || 'sonnet';
  const smallFastModel = provider.smallFastModel || 'haiku';
  const generated = {
    env: Object.fromEntries([
      ['ANTHROPIC_BASE_URL', provider.baseUrl],
      ['ANTHROPIC_AUTH_TOKEN', provider.apiKey],
      ['ANTHROPIC_MODEL', claudeCodeModel],
      ['ANTHROPIC_SMALL_FAST_MODEL', smallFastModel],
      ['DISABLE_NONESSENTIAL_MODEL_CALLS', '1'],
      ['ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', provider.claudeDefaultSonnetModel || ''],
      ['ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', provider.claudeDefaultOpusModel || ''],
      ['ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', provider.claudeDefaultHaikuModel || ''],
      ['ANTHROPIC_DEFAULT_FABLE_MODEL_NAME', provider.claudeDefaultFableModel || '']
    ].filter(([, value]) => String(value).trim())),
    model: claudeCodeModel,
    effortLevel: normalizeClaudeCodeEffort(provider.effortLevel) || 'auto'
  };
  const globalSettings = target?.globalTemplateEnabled !== false
    ? parseJsonFragment(target?.globalTemplate || '')
    : {};
  return JSON.stringify(mergeJsonObjects(globalSettings, generated), null, 2);
}

function parseJsonFragment(fragment: string): Record<string, unknown> {
  const trimmed = fragment.trim().replace(/^,/, '').trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed.startsWith('{') ? trimmed : `{${trimmed}}`);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergeJsonObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = mergeJsonObjects(merged[key] as Record<string, unknown>, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function renderClaudeCodeEnvOverrides(provider: ProviderProfile, model: string, smallFastModel: string): string {
  const entries: Array<[string, string]> = [
    ['ANTHROPIC_MODEL', model],
    ['ANTHROPIC_SMALL_FAST_MODEL', smallFastModel],
    ['DISABLE_NONESSENTIAL_MODEL_CALLS', '1'],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', provider.claudeDefaultSonnetModel || ''],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', provider.claudeDefaultOpusModel || ''],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', provider.claudeDefaultHaikuModel || ''],
    ['ANTHROPIC_DEFAULT_FABLE_MODEL_NAME', provider.claudeDefaultFableModel || '']
  ];
  return entries
    .filter(([, value]) => value.trim())
    .map(([key, value]) => `,\n    "${key}": ${JSON.stringify(value)}`)
    .join('');
}

async function fetchProviderModels(provider: ProviderProfile): Promise<ModelListResult> {
  if (!provider.baseUrl.trim()) {
    throw new Error('Base URL 不能为空。');
  }

  const requests = buildModelListRequests(provider);
  const errors: string[] = [];

  for (const request of requests) {
    let response: Response;
    try {
      response = await fetch(request.endpoint, {
        method: 'GET',
        headers: request.headers
      });
    } catch (error) {
      errors.push(`${request.endpoint} -> ${error instanceof Error ? error.message : '请求失败'}`);
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      errors.push(`${request.endpoint} -> HTTP ${response.status}${body ? ` - ${body.slice(0, 180)}` : ''}`);
      continue;
    }

    const payload = await response.json().catch(() => undefined) as unknown;
    const models = parseModelList(payload);
    if (models.length === 0) {
      errors.push(`${request.endpoint} -> 返回格式无法识别`);
      continue;
    }

    return {
      endpoint: request.endpoint,
      models
    };
  }

  return {
    endpoint: requests.map((request) => request.endpoint).join(', '),
    models: [],
    error: `模型列表获取失败：${errors.join('；')}`
  };
}

function buildModelListRequests(provider: ProviderProfile): Array<{ endpoint: string; headers: Record<string, string> }> {
  const baseUrl = provider.baseUrl.trim().replace(/\/+$/, '');
  const apiKey = provider.apiKey.trim();
  const headers: Record<string, string> = {
    Accept: 'application/json'
  };

  if (/generativelanguage\.googleapis\.com/i.test(baseUrl)) {
    const endpoint = `${baseUrl}/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
    return [{ endpoint, headers }];
  }

  if (/api\.anthropic\.com/i.test(baseUrl)) {
    headers['anthropic-version'] = '2023-06-01';
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }
    const rootUrl = baseUrl.replace(/\/v1$/, '');
    return [
      { endpoint: `${rootUrl}/v1/models`, headers },
      { endpoint: `${rootUrl}/models`, headers }
    ];
  }

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (/\/anthropic$/i.test(baseUrl)) {
    const rootUrl = baseUrl.replace(/\/anthropic$/i, '');
    return [
      { endpoint: `${rootUrl}/models`, headers },
      { endpoint: `${rootUrl}/v1/models`, headers },
      { endpoint: `${baseUrl}/models`, headers }
    ];
  }
  const rootUrl = baseUrl.replace(/\/v1$/, '').replace(/\/models$/, '');
  return [
    { endpoint: baseUrl.endsWith('/models') ? baseUrl : `${baseUrl}/models`, headers },
    { endpoint: `${rootUrl}/v1/models`, headers }
  ];
}

function parseModelList(payload: unknown): string[] {
  const record = isRecord(payload) ? payload : {};
  const rawModels = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];

  return [...new Set(rawModels
    .map((model) => modelId(model))
    .filter((model): model is string => Boolean(model))
    .map((model) => model.replace(/^models\//, '')))]
    .sort((left, right) => left.localeCompare(right));
}

function modelId(model: unknown): string | undefined {
  if (typeof model === 'string') {
    return model;
  }
  if (!isRecord(model)) {
    return undefined;
  }
  const id = model.id || model.name || model.model;
  return typeof id === 'string' ? id : undefined;
}

async function scanLocalCapabilities(savedCapabilities: LocalCapability[] = []): Promise<LocalCapability[]> {
  const saved = new Map(savedCapabilities.map((capability) => [capability.id, capability.enabledTargets]));
  const capabilities: LocalCapability[] = [];
  const codexConfig = await readTextIfExists(path.join(codexHomePath(), 'config.toml'));
  const codexPluginState = parseCodexPluginState(codexConfig);
  const codexSkillState = parseCodexSkillState(codexConfig);
  const claudeSettings = await readJsonIfExists(path.join(os.homedir(), '.claude', 'settings.json'));
  const claudePluginState = isRecord(claudeSettings.enabledPlugins) ? claudeSettings.enabledPlugins : {};

  capabilities.push(...await scanPluginManifests(
    path.join(codexHomePath(), 'plugins', 'cache'),
    'codex',
    '.codex-plugin',
    (key) => codexPluginState.get(key) === true,
    saved
  ));
  capabilities.push(...await scanSkillFiles(
    path.join(codexHomePath(), 'skills'),
    'codex',
    (skillPath) => codexSkillState.get(normalizePathKey(skillPath)) ?? !skillPath.includes(`${path.sep}.system${path.sep}`),
    saved
  ));
  capabilities.push(...await scanPluginManifests(
    path.join(os.homedir(), '.claude', 'plugins', 'cache'),
    'claude',
    '.claude-plugin',
    (key) => claudePluginState[key] === true,
    saved
  ));
  capabilities.push(...await scanSkillFiles(
    path.join(os.homedir(), '.claude', 'skills'),
    'claude',
    (skillPath) => claudePluginState[`${path.basename(path.dirname(skillPath))}@skills-dir`] !== false,
    saved
  ));
  capabilities.push(...await scanGeminiExtensions(saved));
  capabilities.push(...await scanGeminiSkills(saved));

  const uniqueCapabilities = [...new Map(capabilities.map((capability) => [capability.id, capability])).values()];
  return uniqueCapabilities.sort((left, right) => `${left.agent}:${left.kind}:${left.displayName}`.localeCompare(`${right.agent}:${right.kind}:${right.displayName}`));
}

async function scanPluginManifests(
  root: string,
  agent: CapabilityAgentId,
  markerDir: string,
  isEnabled: (key: string) => boolean,
  saved: Map<string, CapabilityAgentId[]>
): Promise<LocalCapability[]> {
  const files = await findFiles(root, 'plugin.json', 8);
  const capabilities: LocalCapability[] = [];

  for (const filePath of files.filter((item) => item.includes(`${path.sep}${markerDir}${path.sep}`))) {
    const manifest = await readJsonIfExists(filePath);
    if (!isRecord(manifest)) {
      continue;
    }

    const packageRoot = path.dirname(path.dirname(filePath));
    const version = String(manifest.version || path.basename(packageRoot));
    const marketplace = marketplaceNameFromCachePath(root, packageRoot);
    const name = stableId(String(manifest.name || path.basename(path.dirname(packageRoot))));
    const displayName = String(
      isRecord(manifest.interface) && manifest.interface.displayName
        ? manifest.interface.displayName
        : manifest.name || name
    );
    const key = `${name}@${marketplace}`;
    const id = `${agent}:plugin:${key}`;

    capabilities.push({
      id,
      agent,
      kind: 'plugin',
      name,
      displayName,
      version,
      marketplace,
      path: packageRoot,
      description: String(manifest.description || ''),
      enabledTargets: saved.get(id) || (isEnabled(key) ? [agent] : [])
    });
  }

  return capabilities;
}

async function scanSkillFiles(
  root: string,
  agent: CapabilityAgentId,
  isEnabled: (skillPath: string) => boolean,
  saved: Map<string, CapabilityAgentId[]>
): Promise<LocalCapability[]> {
  const files = await findFiles(root, 'SKILL.md', 5);
  const capabilities: LocalCapability[] = [];

  for (const filePath of files) {
    if (agent === 'codex' && filePath.includes(`${path.sep}.system${path.sep}`)) {
      continue;
    }
    const meta = parseSkillFrontMatter(await readTextIfExists(filePath));
    const name = stableId(meta.name || path.basename(path.dirname(filePath)));
    const id = `${agent}:skill:${normalizePathKey(filePath)}`;
    capabilities.push({
      id,
      agent,
      kind: 'skill',
      name,
      displayName: meta.name || name,
      version: '',
      path: filePath,
      description: meta.description || '',
      enabledTargets: saved.get(id) || (isEnabled(filePath) ? [agent] : [])
    });
  }

  return capabilities;
}

async function applyLocalCapabilities(capabilities: LocalCapability[]): Promise<CapabilityApplyResult[]> {
  const results: CapabilityApplyResult[] = [];
  const codexCapabilities = capabilities.filter((capability) => capability.agent === 'codex');
  const claudeCapabilities = capabilities.filter((capability) => capability.agent === 'claude');
  const geminiCapabilities = capabilities.filter((capability) => capability.agent === 'gemini');

  if (codexCapabilities.length > 0) {
    const filePath = path.join(codexHomePath(), 'config.toml');
    const content = mergeCodexCapabilities(await readTextIfExists(filePath), codexCapabilities);
    const written = await writeRenderedFile(filePath, content);
    results.push({ ...written, updated: codexCapabilities.length });
  }

  if (claudeCapabilities.length > 0) {
    const filePath = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = await readJsonIfExists(filePath);
    const enabledPlugins = isRecord(settings.enabledPlugins) ? { ...settings.enabledPlugins } : {};
    for (const capability of claudeCapabilities) {
      enabledPlugins[claudeCapabilityKey(capability)] = capability.enabledTargets.includes('claude');
    }
    const content = JSON.stringify({ ...settings, enabledPlugins }, null, 2);
    const written = await writeRenderedFile(filePath, content);
    results.push({ ...written, updated: claudeCapabilities.length });
  }

  if (geminiCapabilities.length > 0) {
    for (const capability of geminiCapabilities) {
      await setGeminiCapabilityEnabled(capability, capability.enabledTargets.includes('gemini'));
    }
    results.push({
      filePath: path.join(os.homedir(), '.gemini', 'settings.json'),
      bytes: 0,
      updated: geminiCapabilities.length
    });
  }

  return results;
}

async function scanGeminiExtensions(saved: Map<string, CapabilityAgentId[]>): Promise<LocalCapability[]> {
  const output = await runCli('gemini', ['extensions', 'list', '--output-format', 'json']).catch(() => '[]');
  const parsed = parseJsonFromOutput(output);
  const entries = Array.isArray(parsed) ? parsed.filter(isRecord) : [];

  return entries.map((entry) => {
    const name = stableId(String(entry.name || entry.id || entry.extensionName || 'extension'));
    const id = `gemini:plugin:${name}`;
    const enabled = entry.enabled !== false && entry.disabled !== true;
    return {
      id,
      agent: 'gemini',
      kind: 'plugin',
      name,
      displayName: String(entry.displayName || entry.name || name),
      version: String(entry.version || ''),
      marketplace: 'gemini',
      path: String(entry.path || entry.installPath || path.join(os.homedir(), '.gemini')),
      description: String(entry.description || ''),
      enabledTargets: saved.get(id) || (enabled ? ['gemini'] : [])
    };
  });
}

async function scanGeminiSkills(saved: Map<string, CapabilityAgentId[]>): Promise<LocalCapability[]> {
  const output = await runCli('gemini', ['skills', 'list', '--all']).catch(() => '');
  const skills = parseGeminiSkillList(output);
  return skills.map((skill) => {
    const id = `gemini:skill:${normalizePathKey(skill.path)}`;
    return {
      id,
      agent: 'gemini',
      kind: 'skill',
      name: skill.name,
      displayName: skill.name,
      version: '',
      path: skill.path,
      description: skill.description,
      enabledTargets: saved.get(id) || (skill.enabled ? ['gemini'] : [])
    };
  });
}

function parseGeminiSkillList(output: string): Array<{ name: string; description: string; path: string; enabled: boolean }> {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const skills: Array<{ name: string; description: string; path: string; enabled: boolean }> = [];
  let current: { name: string; description: string; path: string; enabled: boolean; builtIn: boolean } | undefined;

  for (const line of lines) {
    const header = line.match(/^([A-Za-z0-9_-]+)\s+\[(Enabled|Disabled)\](.*)$/);
    if (header) {
      if (current?.path && !current.builtIn) {
        skills.push(current);
      }
      current = {
        name: stableId(header[1]),
        description: '',
        path: '',
        enabled: header[2] === 'Enabled',
        builtIn: header[3].includes('Built-in')
      };
      continue;
    }

    if (!current) {
      continue;
    }
    const description = line.match(/^\s*Description:\s*(.*)$/)?.[1];
    if (description) {
      current.description = description.trim();
    }
    const location = line.match(/^\s*Location:\s*(.*)$/)?.[1];
    if (location) {
      current.path = location.trim();
    }
  }

  if (current?.path && !current.builtIn) {
    skills.push(current);
  }
  return skills;
}

function parseJsonFromOutput(output: string): unknown {
  const trimmed = output.trim();
  const start = Math.min(...['{', '['].map((char) => {
    const index = trimmed.indexOf(char);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  }));
  if (!Number.isFinite(start)) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return undefined;
  }
}

async function setGeminiCapabilityEnabled(capability: LocalCapability, enabled: boolean): Promise<void> {
  if (capability.kind === 'plugin') {
    await runCli('gemini', ['extensions', enabled ? 'enable' : 'disable', '--scope', 'user', capability.name]);
    return;
  }

  await runCli('gemini', enabled ? ['skills', 'enable', capability.name] : ['skills', 'disable', '--scope', 'user', capability.name]);
}

async function runCli(command: string, args: string[], cwd = os.homedir()): Promise<string> {
  const executable = process.platform === 'win32' ? 'cmd' : command;
  const finalArgs = process.platform === 'win32' ? ['/c', command, ...args] : args;
  const { stdout, stderr } = await execFileAsync(executable, finalArgs, {
    cwd,
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 8
  });
  return `${stdout || ''}${stderr || ''}`.trim();
}

function mergeCodexCapabilities(existing: string, capabilities: LocalCapability[]): string {
  const pluginKeys = new Set(capabilities.filter((item) => item.kind === 'plugin').map(codexCapabilityKey));
  const skillPaths = new Set(capabilities.filter((item) => item.kind === 'skill').map((item) => normalizePathKey(item.path)));
  const preserved = stripCodexCapabilityBlocks(existing, pluginKeys, skillPaths).trimEnd();
  const block = buildCodexCapabilitiesBlock(capabilities);
  return preserved ? `${preserved}\n\n${block}` : block;
}

function buildCodexCapabilitiesBlock(capabilities: LocalCapability[]): string {
  const lines = [capabilityBlockStart, '# Managed by Agent Router'];
  for (const capability of capabilities.filter((item) => item.kind === 'plugin')) {
    lines.push('', `[plugins.${JSON.stringify(codexCapabilityKey(capability))}]`, `enabled = ${capability.enabledTargets.includes('codex')}`);
  }
  for (const capability of capabilities.filter((item) => item.kind === 'skill')) {
    lines.push('', '[[skills.config]]', `path = ${JSON.stringify(capability.path)}`, `enabled = ${capability.enabledTargets.includes('codex')}`);
  }
  lines.push(capabilityBlockEnd, '');
  return lines.join('\n');
}

function stripCodexCapabilityBlocks(existing: string, pluginKeys: Set<string>, skillPaths: Set<string>): string {
  const withoutManagedBlock = existing.replace(
    new RegExp(`${escapeRegExp(capabilityBlockStart)}[\\s\\S]*?${escapeRegExp(capabilityBlockEnd)}\\r?\\n?`, 'g'),
    ''
  );
  const lines = withoutManagedBlock.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const pluginKey = line.match(/^\s*\[plugins\."([^"]+)"\]\s*$/)?.[1];
    if (pluginKey && pluginKeys.has(pluginKey)) {
      index = nextTomlTableIndex(lines, index + 1);
      continue;
    }

    if (/^\s*\[\[skills\.config\]\]\s*$/.test(line)) {
      const nextIndex = nextTomlTableIndex(lines, index + 1);
      const block = lines.slice(index, nextIndex);
      const skillPath = block.join('\n').match(/^\s*path\s*=\s*"([^"]+)"/m)?.[1];
      if (skillPath && skillPaths.has(normalizePathKey(skillPath))) {
        index = nextIndex;
        continue;
      }
      kept.push(...block);
      index = nextIndex;
      continue;
    }

    kept.push(line);
    index += 1;
  }

  return kept.join('\n');
}

function nextTomlTableIndex(lines: string[], startIndex: number): number {
  let index = startIndex;
  while (index < lines.length && !/^\s*\[/.test(lines[index])) {
    index += 1;
  }
  return index;
}

function parseCodexPluginState(content: string): Map<string, boolean> {
  const state = new Map<string, boolean>();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let activeKey = '';

  for (const line of lines) {
    const pluginKey = line.match(/^\s*\[plugins\."([^"]+)"\]\s*$/)?.[1];
    if (pluginKey) {
      activeKey = pluginKey;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      activeKey = '';
      continue;
    }
    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*$/)?.[1];
    if (activeKey && enabled) {
      state.set(activeKey, enabled === 'true');
    }
  }

  return state;
}

function parseCodexSkillState(content: string): Map<string, boolean> {
  const state = new Map<string, boolean>();
  const blocks = content.replace(/\r\n/g, '\n').split(/(?=^\s*\[\[skills\.config\]\]\s*$)/m);
  for (const block of blocks) {
    if (!block.includes('[[skills.config]]')) {
      continue;
    }
    const skillPath = block.match(/^\s*path\s*=\s*"([^"]+)"/m)?.[1];
    const enabled = block.match(/^\s*enabled\s*=\s*(true|false)\s*$/m)?.[1];
    if (skillPath && enabled) {
      state.set(normalizePathKey(skillPath), enabled === 'true');
    }
  }
  return state;
}

function codexCapabilityKey(capability: LocalCapability): string {
  return capability.kind === 'plugin'
    ? `${capability.name}@${capability.marketplace || 'local'}`
    : capability.path;
}

function claudeCapabilityKey(capability: LocalCapability): string {
  return capability.kind === 'plugin'
    ? `${capability.name}@${capability.marketplace || 'local'}`
    : `${capability.name}@skills-dir`;
}

function marketplaceNameFromCachePath(root: string, packageRoot: string): string {
  const relative = path.relative(root, packageRoot).split(path.sep);
  return relative[0] || 'local';
}

async function findFiles(root: string, fileName: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        found.push(entryPath);
      }
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return found;
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseSkillFrontMatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const meta: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!item) {
      continue;
    }
    const value = item[2].trim().replace(/^['"]|['"]$/g, '');
    if (item[1] === 'name') {
      meta.name = value;
    }
    if (item[1] === 'description') {
      meta.description = value;
    }
  }
  return meta;
}

function normalizePathKey(filePath: string): string {
  return path.normalize(filePath).toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  ipcMain.handle('state:load', loadState);
  ipcMain.handle('state:save', async (_event, state: AppState) => saveState(state));
  ipcMain.handle('target:apply', async (_event, targetId: string, state: AppState) => {
    const saved = await saveState(state);
    const target = saved.targets.find((item) => item.id === targetId);
    if (!target) {
      throw new Error(`Target not found: ${targetId}`);
    }
    return applyTarget(target, saved);
  });
  ipcMain.handle('target:applyAll', async (_event, state: AppState) => {
    const saved = await saveState(state);
    const results: ApplyResult[] = [];
    for (const target of saved.targets) {
      results.push(await applyTarget(target, saved));
    }
    return results;
  });
  ipcMain.handle('provider:models', async (_event, provider: ProviderProfile) => fetchProviderModels(provider));
  ipcMain.handle('capability:scan', async (_event, state: AppState) => scanLocalCapabilities(normalizeCapabilities(state.capabilities)));
  ipcMain.handle('capability:apply', async (_event, capabilities: LocalCapability[]) => applyLocalCapabilities(normalizeCapabilities(capabilities)));
  ipcMain.handle('target:read', async (_event, filePath: string) => {
    return readFile(resolveKnownDefaultPath(filePath), 'utf8');
  });
  ipcMain.handle('target:watch', async (event, watchId: string, filePath: string) => watchTargetFile(event.sender.id, watchId, filePath, (payload) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('target:changed', payload);
    }
  }));
  ipcMain.handle('target:unwatch', (event, watchId?: string) => {
    if (watchId) {
      closeTargetWatcher(event.sender.id, watchId);
      return;
    }
    closeAllTargetWatchers(event.sender.id);
  });
  ipcMain.handle('path:reveal', async (_event, filePath: string) => {
    const resolvedPath = resolveKnownDefaultPath(filePath);
    const result = await shell.showItemInFolder(resolvedPath);
    return result;
  });
  ipcMain.handle('path:choose', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select config file',
      properties: ['openFile', 'showHiddenFiles', 'createDirectory']
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
