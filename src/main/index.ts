import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { constants, watch, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppState, ApplyResult, ModelListResult, ProviderProfile, ToolTarget } from '../shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultGlobalPrompt = 'You are a pragmatic coding agent. Prefer direct execution, concise updates, and verified results.';
const fileWatchers = new Map<string, { watcher: FSWatcher; debounce?: NodeJS.Timeout }>();
const environmentCache = new Map<string, string | undefined>();
const legacyCodexConfigPath = '%USERPROFILE%/.codex/config.toml';
const legacyCodexPromptPath = '%USERPROFILE%/.codex/AGENTS.md';
const managedBlockStart = '# >>> Agent Router managed';
const managedBlockEnd = '# <<< Agent Router managed';
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
        '  "model": {{json.provider.defaultModel}}',
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
    targets: normalizeTargets(input.targets, legacyProviders, legacyActiveProviderId, input.globalPrompt)
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

app.whenReady().then(() => {
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
