export type ProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  modelOptions?: string[];
  smallFastModel?: string;
  claudeDefaultSonnetModel?: string;
  claudeDefaultOpusModel?: string;
  claudeDefaultHaikuModel?: string;
  claudeDefaultFableModel?: string;
  effortLevel?: string;
  reasoningEffort?: string;
  millionContextEnabled?: boolean;
  note?: string;
};

export type ToolTarget = {
  id: string;
  name: string;
  activeProviderId: string;
  appliedProviderId?: string;
  providers: ProviderProfile[];
  globalPrompt: string;
  globalPromptEnabled?: boolean;
  globalTemplate?: string;
  globalTemplateEnabled?: boolean;
  promptFilePath?: string;
  filePath: string;
  template: string;
  backupRetention?: number;
  note?: string;
};

export type AppState = {
  targets: ToolTarget[];
  capabilities?: LocalCapability[];
};

export type ApplyResult = {
  targetId: string;
  targetName: string;
  filePath: string;
  backupPath?: string;
  bytes: number;
  promptFilePath?: string;
  promptBackupPath?: string;
  promptBytes?: number;
};

export type ModelListResult = {
  endpoint: string;
  models: string[];
  error?: string;
};

export type CapabilityKind = 'plugin' | 'skill';

export type CapabilityAgentId = 'codex' | 'claude' | 'gemini';

export type LocalCapability = {
  id: string;
  kind: CapabilityKind;
  name: string;
  displayName: string;
  version: string;
  agent: CapabilityAgentId;
  marketplace?: string;
  path: string;
  description?: string;
  enabledTargets: CapabilityAgentId[];
};
