export type ConfigAgentId = 'codex' | 'claude' | 'gemini';

type JsonObject = Record<string, unknown>;

const defaultCodexGlobalConfig = [
  'model_reasoning_summary = "auto"',
  'model_verbosity = "medium"',
  'personality = "pragmatic"'
].join('\n');

const defaultClaudeGlobalSettings: JsonObject = {
  permissions: {
    allow: [],
    deny: []
  }
};

const defaultGeminiGlobalSettings: JsonObject = {
  general: {
    previewFeatures: false
  }
};

export const DEFAULT_GLOBAL_TEMPLATES = {
  codex: defaultCodexGlobalConfig,
  claude: formatJsonFragment(defaultClaudeGlobalSettings, false),
  gemini: formatJsonFragment(defaultGeminiGlobalSettings, true)
} satisfies Record<ConfigAgentId, string>;

export function mergeImportedGlobalConfig(agentId: string, content: string): string {
  if (agentId === 'codex') {
    return mergeCodexGlobalConfig(stripCodexManagedConfig(content));
  }
  if (agentId === 'claude') {
    const imported = parseNonManagedJsonConfig(content, {
      agentName: 'Claude Code',
      topLevelKeys: ['model', 'effortLevel'],
      envKeys: [
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_SMALL_FAST_MODEL',
        'DISABLE_NONESSENTIAL_MODEL_CALLS',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_FABLE_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
        'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
        'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
        'CLAUDE_CODE_EFFORT_LEVEL'
      ]
    });
    return formatJsonFragment(mergeJsonObjects(defaultClaudeGlobalSettings, imported), false);
  }
  if (agentId === 'gemini') {
    const imported = parseNonManagedJsonConfig(content, {
      agentName: 'Gemini',
      topLevelKeys: ['apiEndpoint', 'apiKey', 'model'],
      envKeys: []
    });
    return formatJsonFragment(mergeJsonObjects(defaultGeminiGlobalSettings, imported), true);
  }
  return content.trim();
}

function mergeCodexGlobalConfig(imported: string): string {
  // ponytail: Codex 暂按根键合并；需要嵌套键级覆盖时再引入 TOML 解析器。
  const importedRootKeys = collectTomlRootKeys(imported);
  const missingDefaults = defaultCodexGlobalConfig
    .split('\n')
    .filter((line) => {
      const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
      return !key || !importedRootKeys.has(key);
    })
    .join('\n');

  return [missingDefaults, imported.trim()].filter(Boolean).join('\n\n');
}

function collectTomlRootKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    if (parseTomlTableName(line)) {
      break;
    }
    const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

function stripCodexManagedConfig(content: string): string {
  const withoutManagedBlock = content
    .replace(/# >>> Agent Router managed[\s\S]*?# <<< Agent Router managed\r?\n?/g, '')
    .replace(/\r\n/g, '\n');
  const lines = withoutManagedBlock.split('\n');
  const kept: string[] = [];
  let currentTable: string | undefined;
  let skippingManagedTable = false;
  const managedTopLevelKeys = new Set([
    'model',
    'model_provider',
    'model_reasoning_effort',
    'model_context_window'
  ]);
  const managedTables = new Set([
    'model_providers.agent-router',
    'model_providers."agent-router"'
  ]);

  for (const line of lines) {
    const tableName = parseTomlTableName(line);
    if (tableName) {
      currentTable = tableName;
      skippingManagedTable = managedTables.has(tableName);
      if (!skippingManagedTable) {
        kept.push(line);
      }
      continue;
    }
    if (skippingManagedTable) {
      continue;
    }
    if (!currentTable) {
      const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
      if (key && managedTopLevelKeys.has(key)) {
        continue;
      }
      if (line.trim() === '# Managed by Agent Router') {
        continue;
      }
    }
    kept.push(line);
  }

  return kept.join('\n').trim();
}

function parseTomlTableName(line: string): string | undefined {
  const arrayTable = line.match(/^\s*\[\[([^\]]+)]]\s*(?:#.*)?$/)?.[1]?.trim();
  return arrayTable || line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/)?.[1]?.trim();
}

function parseNonManagedJsonConfig(
  content: string,
  options: { agentName: string; topLevelKeys: string[]; envKeys: string[] }
): JsonObject {
  if (!content.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${options.agentName} 当前配置不是有效的 JSON，未执行导入`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${options.agentName} 当前配置必须是 JSON 对象，未执行导入`);
  }

  const cleaned: JsonObject = {};
  const managedTopLevelKeys = new Set(options.topLevelKeys);
  const managedEnvKeys = new Set(options.envKeys);

  for (const [key, value] of Object.entries(parsed)) {
    if (managedTopLevelKeys.has(key)) {
      continue;
    }
    if (key === 'env' && isJsonObject(value)) {
      const env = Object.fromEntries(
        Object.entries(value).filter(([envKey]) => !managedEnvKeys.has(envKey))
      );
      if (Object.keys(env).length > 0) {
        cleaned.env = env;
      }
      continue;
    }
    cleaned[key] = value;
  }

  return cleaned;
}

function mergeJsonObjects(base: JsonObject, overrides: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (isJsonObject(value) && isJsonObject(merged[key])) {
      merged[key] = mergeJsonObjects(merged[key] as JsonObject, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function formatJsonFragment(value: JsonObject, leadingComma: boolean): string {
  const body = JSON.stringify(value, null, 2).split('\n').slice(1, -1).join('\n');
  return body ? `${leadingComma ? ',\n' : ''}${body}` : '';
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
