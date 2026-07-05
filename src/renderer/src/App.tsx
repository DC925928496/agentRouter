import {
  Copy,
  FileCode2,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import type { AppState, ApplyResult, ProviderProfile, ToolTarget } from '../../shared/types';
import claudeLogo from './assets/agents/claude-color.svg';
import geminiLogo from './assets/agents/gemini-color.svg';
import openaiLogo from './assets/agents/openai-color.svg';

const emptyState: AppState = {
  targets: []
};

function App(): ReactElement {
  const [state, setState] = useState<AppState>(emptyState);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('正在读取本地配置...');
  const [startupError, setStartupError] = useState('');
  const [configPreview, setConfigPreview] = useState('');
  const [promptPreview, setPromptPreview] = useState('');
  const [settingsAgentId, setSettingsAgentId] = useState('');
  const [modelOptionsByProvider, setModelOptionsByProvider] = useState<Record<string, string[]>>({});
  const [modelLoadingKey, setModelLoadingKey] = useState('');

  const selectedAgent = useMemo(
    () => state.targets.find((target) => target.id === selectedAgentId) || state.targets[0],
    [selectedAgentId, state.targets]
  );
  const activeProvider = useMemo(
    () => selectedAgent?.providers.find((provider) => provider.id === selectedAgent.activeProviderId) || selectedAgent?.providers[0],
    [selectedAgent]
  );
  const appliedProvider = useMemo(
    () => selectedAgent?.providers.find((provider) => provider.id === selectedAgent.appliedProviderId) || activeProvider,
    [activeProvider, selectedAgent]
  );
  const activeProviderModels = useMemo(() => {
    if (!selectedAgent || !activeProvider) {
      return [];
    }
    const fetchedModels = modelOptionsByProvider[providerOptionsKey(selectedAgent.id, activeProvider.id)] || [];
    return fetchedModels.length > 0 ? fetchedModels : activeProvider.modelOptions || [];
  }, [activeProvider, modelOptionsByProvider, selectedAgent]);

  useEffect(() => {
    if (!window.agentRouter) {
      setStartupError('Electron preload 未加载，无法访问本地配置 API。');
      return;
    }

    window.agentRouter
      .loadState()
      .then((loaded) => {
        setState(loaded);
        setSelectedAgentId(loaded.targets[0]?.id || '');
        setMessage('配置已加载');
      })
      .catch((error: Error) => setStartupError(error.message));
  }, []);

  useEffect(() => {
    if (!selectedAgent || !window.agentRouter) {
      return;
    }

    let active = true;
    const removeListener = window.agentRouter.onTargetChanged((payload) => {
      if (!active) return;
      if (payload.watchId === 'config') {
        setConfigPreview(payload.content);
        setMessage(payload.error ? `${selectedAgent.name} 配置未读取：${payload.error}` : `${selectedAgent.name} 配置已更新`);
      }
      if (payload.watchId === 'prompt') {
        setPromptPreview(payload.content);
        if (!payload.error) {
          updateAgent(selectedAgent.id, { globalPrompt: payload.content });
        }
        setMessage(payload.error ? `${selectedAgent.name} 提示词未读取：${payload.error}` : `${selectedAgent.name} 提示词已更新`);
      }
    });

    if (selectedAgent.filePath) {
      window.agentRouter
        .watchTarget('config', selectedAgent.filePath)
        .then((payload) => {
          if (!active) return;
          setConfigPreview(payload.content);
          setMessage(payload.error ? `${selectedAgent.name} 配置未读取：${payload.error}` : `已加载 ${selectedAgent.name} 当前配置`);
        })
        .catch((error: Error) => {
          if (!active) return;
          setConfigPreview('');
          setMessage(error.message);
        });
    }

    if (selectedAgent.promptFilePath) {
      window.agentRouter
        .watchTarget('prompt', selectedAgent.promptFilePath)
        .then((payload) => {
          if (!active) return;
          setPromptPreview(payload.content);
          if (!payload.error) {
            updateAgent(selectedAgent.id, { globalPrompt: payload.content });
          }
        })
        .catch((error: Error) => {
          if (!active) return;
          setPromptPreview('');
          setMessage(error.message);
        });
    } else {
      setPromptPreview('');
    }

    return () => {
      active = false;
      removeListener();
    };
  }, [selectedAgent?.id, selectedAgent?.filePath, selectedAgent?.promptFilePath]);

  if (startupError) {
    return (
      <main className="startup-error">
        <section>
          <h1>Agent Router 启动失败</h1>
          <p>{startupError}</p>
        </section>
      </main>
    );
  }

  function updateAgent(id: string, patch: Partial<ToolTarget>): void {
    setState((current) => ({
      ...current,
      targets: current.targets.map((target) => (target.id === id ? { ...target, ...patch } : target))
    }));
  }

  function updateProvider(agentId: string, providerId: string, patch: Partial<ProviderProfile>): void {
    setState((current) => ({
      ...current,
      targets: current.targets.map((target) =>
        target.id === agentId
          ? {
              ...target,
              providers: target.providers.map((provider) =>
                provider.id === providerId ? { ...provider, ...patch } : provider
              )
            }
          : target
      )
    }));
  }

  function setActiveProvider(agentId: string, providerId: string): void {
    updateAgent(agentId, { activeProviderId: providerId });
  }

  function addProvider(agent: ToolTarget): void {
    const id = `provider-${Date.now()}`;
    updateAgent(agent.id, {
      activeProviderId: id,
      providers: [
        ...agent.providers,
        {
          id,
          name: 'New provider',
          baseUrl: 'https://',
          apiKey: '',
          defaultModel: '',
          modelOptions: [],
          smallFastModel: '',
          effortLevel: agent.id === 'claude' ? 'auto' : '',
          reasoningEffort: '',
          millionContextEnabled: false,
          note: ''
        }
      ]
    });
  }

  function removeProvider(agent: ToolTarget, providerId: string): void {
    if (agent.providers.length <= 1) return;
    const providers = agent.providers.filter((provider) => provider.id !== providerId);
    const fallbackProviderId = providers[0].id;
    updateAgent(agent.id, {
      providers,
      activeProviderId: agent.activeProviderId === providerId ? fallbackProviderId : agent.activeProviderId,
      appliedProviderId: agent.appliedProviderId === providerId ? fallbackProviderId : agent.appliedProviderId
    });
  }

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const saved = await window.agentRouter.saveState(state);
      setState(saved);
      setMessage('已保存本地设置');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function applyOne(agent: ToolTarget): Promise<void> {
    setBusy(true);
    try {
      const result = await window.agentRouter.applyTarget(agent.id, state);
      const appliedState = markProviderApplied(state, agent.id);
      const saved = await window.agentRouter.saveState(appliedState);
      setState(saved);
      setMessage(formatApplyResult(result));
      await reloadAgentFiles(agent);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '应用失败');
    } finally {
      setBusy(false);
    }
  }

  async function fetchModels(agent: ToolTarget, provider: ProviderProfile): Promise<void> {
    const key = providerOptionsKey(agent.id, provider.id);
    setModelLoadingKey(key);
    try {
      const result = await window.agentRouter.fetchProviderModels(provider);
      if (result.error) {
        setMessage(result.error);
        return;
      }
      const models = uniqueStrings(result.models);
      setModelOptionsByProvider((current) => ({
        ...current,
        [key]: models
      }));
      if (!provider.defaultModel && models[0]) {
        updateProvider(agent.id, provider.id, { defaultModel: models[0], modelOptions: models });
      } else {
        updateProvider(agent.id, provider.id, { modelOptions: models });
      }
      setMessage(`已获取 ${models.length} 个模型：${result.endpoint}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '模型列表获取失败');
    } finally {
      setModelLoadingKey('');
    }
  }

  async function reloadAgentFiles(agent: ToolTarget): Promise<void> {
    if (agent.filePath) {
      const configPayload = await window.agentRouter.watchTarget('config', agent.filePath);
      setConfigPreview(configPayload.content);
    }
    if (agent.promptFilePath) {
      const promptPayload = await window.agentRouter.watchTarget('prompt', agent.promptFilePath);
      setPromptPreview(promptPayload.content);
    }
  }

  async function generateGlobalTemplate(agent: ToolTarget): Promise<void> {
    if (!agent.filePath) {
      setMessage(`${agent.name} 未设置配置文件路径`);
      return;
    }

    setBusy(true);
    try {
      const payload = await window.agentRouter.watchTarget('config', agent.filePath);
      setConfigPreview(payload.content);
      if (payload.error) {
        setMessage(`${agent.name} 配置未读取：${payload.error}`);
        return;
      }

      const generated = buildGlobalTemplateFromConfig(agent.id, payload.content);
      const patch: Partial<ToolTarget> = {
        globalTemplate: generated,
        globalTemplateEnabled: true
      };
      let promptMessage = '';

      if (!agent.globalPrompt.trim() && agent.promptFilePath) {
        const promptPayload = await window.agentRouter.watchTarget('prompt', agent.promptFilePath);
        setPromptPreview(promptPayload.content);
        if (promptPayload.error) {
          promptMessage = `，提示词未读取：${promptPayload.error}`;
        } else {
          patch.globalPrompt = promptPayload.content;
          promptMessage = promptPayload.content.trim() ? '，全局提示词已从当前提示词文件填入' : '，当前提示词文件为空';
        }
      }

      updateAgent(agent.id, patch);
      setMessage(`${generated.trim() ? `${agent.name} 通用配置已从当前配置生成` : `${agent.name} 当前配置没有可保留的通用配置`}${promptMessage}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '通用配置生成失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <div className="toast-message" role="status" aria-live="polite">
        <span>{message}</span>
      </div>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AR</div>
          <div>
            <h1>Agent Router</h1>
            <p>Agent 配置切换台</p>
          </div>
        </div>

        <section className="panel compact">
          <div className="section-title">
            <span className="section-mark">AR</span>
            <span>Agents</span>
          </div>
          <div className="agent-list">
            {state.targets.map((agent) => {
              const provider = agent.providers.find((item) => item.id === agent.appliedProviderId) ||
                agent.providers.find((item) => item.id === agent.activeProviderId) ||
                agent.providers[0];
              return (
                <div
                  className={`agent-item ${agent.id === selectedAgent?.id ? 'active' : ''}`}
                  key={agent.id}
                >
                  <button
                    className="agent-main"
                    onClick={() => {
                      setSelectedAgentId(agent.id);
                      setConfigPreview('');
                      setPromptPreview('');
                    }}
                  >
                    <span>
                      <AgentIcon id={agent.id} />
                      {agent.name}
                    </span>
                    <small>已应用：{provider?.name || '未设置服务商'}</small>
                  </button>
                  <button
                    className="agent-gear"
                    title="参与设置"
                    onClick={() => {
                      setSelectedAgentId(agent.id);
                      setSettingsAgentId(settingsAgentId === agent.id ? '' : agent.id);
                    }}
                  >
                    <Settings2 size={16} />
                  </button>
                  {settingsAgentId === agent.id && (
                    <div className="agent-settings">
                      <label className="mini-toggle">
                        <input
                          type="checkbox"
                          checked={agent.globalPromptEnabled !== false}
                          onChange={(event) => updateAgent(agent.id, { globalPromptEnabled: event.target.checked })}
                        />
                        提示词文件参与写入
                      </label>
                      <label className="mini-toggle">
                        <input
                          type="checkbox"
                          checked={agent.globalTemplateEnabled !== false}
                          onChange={(event) => updateAgent(agent.id, { globalTemplateEnabled: event.target.checked })}
                        />
                        全局通用配置参与写入
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

      </aside>

	      {selectedAgent && activeProvider && (
	        <section className="workspace">
          <header className="topbar">
            <div>
              <p className="eyebrow">Active agent</p>
              <h2>{selectedAgent.name}</h2>
	              <p className="route-line">
	                当前生效：{appliedProvider?.name || '未设置服务商'} / {appliedProvider?.defaultModel || '未设置模型'}，正在编辑：{activeProvider.name}
	              </p>
            </div>
            <div className="actions">
              <button className="secondary" disabled={busy} onClick={save}>
                <Save size={16} /> 保存
              </button>
              <button className="primary write-current" disabled={busy} onClick={() => applyOne(selectedAgent)}>
                <Copy size={16} /> 写入当前 Agent
              </button>
            </div>
          </header>

          <div className="content-grid agent-workbench">
            <section className="panel provider-editor">
              <div className="section-title spread">
                <span><KeyRound size={18} /> {selectedAgent.name} 服务商</span>
                <button className="secondary" onClick={() => addProvider(selectedAgent)}>
                  <Plus size={16} /> 新增服务商
                </button>
              </div>

	              <div className="provider-list horizontal">
	                {selectedAgent.providers.map((provider) => {
	                  const isEditing = provider.id === selectedAgent.activeProviderId;
	                  const isApplied = provider.id === selectedAgent.appliedProviderId;
	                  return (
	                    <button
	                      className={`provider-item ${isEditing ? 'active' : ''} ${isApplied ? 'applied' : ''}`}
	                      key={provider.id}
	                      onClick={() => setActiveProvider(selectedAgent.id, provider.id)}
	                    >
	                      <span>
	                        {provider.name}
	                        {isApplied && <b>当前</b>}
	                      </span>
	                      <small>{provider.defaultModel || '未设置模型'}</small>
	                    </button>
	                  );
	                })}
	              </div>

              <div className="section-title spread editor-heading">
                <span><Settings2 size={18} /> 生效服务商配置</span>
                {selectedAgent.providers.length > 1 && (
                  <button
                    className="icon danger"
                    title="删除服务商"
                    onClick={() => removeProvider(selectedAgent, activeProvider.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>

              <div className="form-grid">
                <label>
                  名称
                  <input
                    value={activeProvider.name}
                    onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { name: event.target.value })}
                  />
                </label>
	                <label>
	                  {selectedAgent.id === 'claude' ? '主模型' : '默认模型'}
	                  <div className="model-picker">
	                    <ModelSelect
	                      models={activeProviderModels}
	                      value={activeProvider.defaultModel}
	                      onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { defaultModel: event.target.value })}
	                      placeholder="手动输入或先获取模型列表"
	                    />
	                    <button
	                      className="secondary model-fetch"
	                      disabled={busy || modelLoadingKey === providerOptionsKey(selectedAgent.id, activeProvider.id)}
	                      title="获取模型列表"
	                      onClick={() => fetchModels(selectedAgent, activeProvider)}
	                    >
	                      <RefreshCw size={16} />
	                    </button>
	                  </div>
	                </label>
	                {selectedAgent.id === 'claude' && (
	                  <label>
	                    快速模型
	                    <ModelSelect
	                      models={activeProviderModels}
	                      value={activeProvider.smallFastModel || 'haiku'}
	                      onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { smallFastModel: event.target.value })}
	                      placeholder="选择或输入快速模型"
	                    />
	                  </label>
	                )}
	                <label>
	                  {selectedAgent.id === 'claude' ? 'Claude 思维强度' : '思维强度'}
	                  {selectedAgent.id === 'claude' ? (
	                    <select
	                      value={activeProvider.effortLevel || 'auto'}
	                      onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { effortLevel: event.target.value })}
	                    >
	                      <option value="auto">auto</option>
	                      <option value="low">low</option>
	                      <option value="medium">medium</option>
	                      <option value="high">high</option>
	                    </select>
	                  ) : (
	                    <select
	                      value={activeProvider.reasoningEffort || ''}
	                      onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { reasoningEffort: event.target.value })}
	                    >
	                      <option value="">跟随 Codex 默认</option>
	                      <option value="minimal">minimal</option>
	                      <option value="low">low</option>
	                      <option value="medium">medium</option>
	                      <option value="high">high</option>
	                      <option value="xhigh">xhigh</option>
	                    </select>
	                  )}
	                </label>
	                {selectedAgent.id === 'claude' && (
	                  <div className="claude-model-map wide">
		                    <label>
		                      Sonnet 指向
		                      <ModelSelect
		                        models={activeProviderModels}
		                        value={activeProvider.claudeDefaultSonnetModel || ''}
		                        onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { claudeDefaultSonnetModel: event.target.value })}
		                        placeholder="留空使用 Claude Code 默认"
		                      />
		                    </label>
		                    <label>
		                      Opus 指向
		                      <ModelSelect
		                        models={activeProviderModels}
		                        value={activeProvider.claudeDefaultOpusModel || ''}
		                        onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { claudeDefaultOpusModel: event.target.value })}
		                        placeholder="留空使用 Claude Code 默认"
		                      />
		                    </label>
		                    <label>
		                      Haiku 指向
		                      <ModelSelect
		                        models={activeProviderModels}
		                        value={activeProvider.claudeDefaultHaikuModel || ''}
		                        onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { claudeDefaultHaikuModel: event.target.value })}
		                        placeholder="留空使用 Claude Code 默认"
		                      />
		                    </label>
		                    <label>
		                      Fable 指向
		                      <ModelSelect
		                        models={activeProviderModels}
		                        value={activeProvider.claudeDefaultFableModel || ''}
		                        onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { claudeDefaultFableModel: event.target.value })}
		                        placeholder="留空使用 Claude Code 默认"
	                      />
	                    </label>
	                  </div>
	                )}
	                {selectedAgent.id !== 'claude' && (
	                  <label className="context-toggle">
	                    <input
	                      type="checkbox"
	                      checked={Boolean(activeProvider.millionContextEnabled)}
	                      onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { millionContextEnabled: event.target.checked })}
	                    />
	                    开启 1m 上下文
	                  </label>
	                )}
                <label className="wide">
                  Base URL
                  <input
                    value={activeProvider.baseUrl}
                    onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { baseUrl: event.target.value })}
                  />
                </label>
                <label className="wide">
                  API Key
                  <input
                    type="password"
                    value={activeProvider.apiKey}
                    onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { apiKey: event.target.value })}
                    placeholder="只写入本机配置"
                  />
                </label>
                <label className="wide">
                  备注
                  <input
                    value={activeProvider.note || ''}
                    onChange={(event) => updateProvider(selectedAgent.id, activeProvider.id, { note: event.target.value })}
                  />
                </label>
              </div>
            </section>

            <section className="panel prompt-editor global-editor">
	              <div className="section-title spread">
	                <span><FileCode2 size={18} /> 全局参与配置</span>
	                <div className="global-actions">
	                  <button className="secondary" disabled={busy} onClick={() => generateGlobalTemplate(selectedAgent)}>
	                    <FileCode2 size={16} /> 从当前配置生成
	                  </button>
	                  <div className="participation-badges">
	                    <span className={selectedAgent.globalPromptEnabled !== false ? 'badge on' : 'badge'}>提示词</span>
	                    <span className={selectedAgent.globalTemplateEnabled !== false ? 'badge on' : 'badge'}>通用配置</span>
	                  </div>
	                </div>
	              </div>
              <label>
                全局提示词 Markdown
                <textarea
                  className="prompt-box"
                  value={selectedAgent.globalPrompt}
                  onChange={(event) => updateAgent(selectedAgent.id, { globalPrompt: event.target.value })}
                />
              </label>
              <label>
                全局通用配置
                <textarea
                  className="common-config-box"
                  value={selectedAgent.globalTemplate || ''}
                  onChange={(event) => updateAgent(selectedAgent.id, { globalTemplate: event.target.value })}
                  placeholder="用于填写不属于 URL / Key 的 Agent 配置，例如权限、行为开关、额外模型参数。"
                />
              </label>
            </section>
          </div>

          <section className="targets-band">
            <div className="targets-header">
              <div>
                <p className="eyebrow">Agent config</p>
                <h3>{selectedAgent.name} 写入目标</h3>
              </div>
            </div>

            <div className="target-editor">
              <div className="target-meta">
                <label>
                  Agent 名称
                  <input
                    value={selectedAgent.name}
                    onChange={(event) => updateAgent(selectedAgent.id, { name: event.target.value })}
                  />
                </label>
                <label className="backup-row">
                  保留备份
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={selectedAgent.backupRetention ?? 3}
                    onChange={(event) => updateAgent(selectedAgent.id, { backupRetention: Number(event.target.value) })}
                  />
                </label>
                <div className="target-buttons">
                  <button className="primary" disabled={busy} onClick={() => reloadAgentFiles(selectedAgent)}>
                    <FileCode2 size={16} /> 读取
                  </button>
                </div>
              </div>

              <label className="note-row">
                说明
                <input value={selectedAgent.note || ''} onChange={(event) => updateAgent(selectedAgent.id, { note: event.target.value })} />
              </label>

              <div className="template-grid">
                <label>
                  当前配置文件内容
                  <MarkdownView
                    codeLanguage={languageForPath(selectedAgent.filePath)}
                    content={configPreview}
                    emptyText="配置文件不存在或暂无内容"
                  />
                </label>
                <label>
                  当前提示词文件内容 Markdown
                  <MarkdownView content={promptPreview} emptyText="提示词文件不存在或暂无内容" />
                </label>
              </div>

              <div className="template-footer">
                <p>每个 Agent 同时只有一个服务商生效。当前文件内容会自动读取，外部改动会自动刷新。</p>
              </div>
            </div>
          </section>
        </section>
      )}
    </main>
  );
}

function providerOptionsKey(agentId: string, providerId: string): string {
  return `${agentId}:${providerId}`;
}

function ModelSelect({
  models,
  value,
  onChange,
  placeholder
}: {
  models: string[];
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  placeholder: string;
}): ReactElement {
  if (models.length === 0) {
    return <input value={value} onChange={onChange} placeholder={placeholder} />;
  }

  const hasCurrentValue = Boolean(value);
  const currentValueInModels = hasCurrentValue && models.includes(value);
  return (
    <select value={value} onChange={onChange}>
      {!hasCurrentValue && <option value="">{placeholder}</option>}
      {hasCurrentValue && !currentValueInModels && <option value={value}>{value}（当前，不在模型列表）</option>}
      {models.map((model) => (
        <option value={model} key={model}>{model}</option>
      ))}
    </select>
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildGlobalTemplateFromConfig(agentId: string, content: string): string {
  if (!content.trim()) {
    return '';
  }
  if (agentId === 'codex') {
    return stripCodexManagedConfig(content);
  }
	  if (agentId === 'claude') {
	    return stripJsonManagedConfig(content, {
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
	      ],
	      leadingComma: false
	    });
	  }
	  if (agentId === 'gemini') {
	    return stripJsonManagedConfig(content, {
	      topLevelKeys: ['apiEndpoint', 'apiKey', 'model'],
	      envKeys: [],
	      leadingComma: true
	    });
	  }
  return content.trim();
}

function stripCodexManagedConfig(content: string): string {
  const withoutManagedBlock = content
    .replace(/# >>> Agent Router managed[\s\S]*?# <<< Agent Router managed\r?\n?/g, '')
    .replace(/\r\n/g, '\n');
  const lines = withoutManagedBlock.split('\n');
  const kept: string[] = [];
  let skippingManagedTable = false;
  const managedTopLevelKeys = new Set([
    'model',
    'model_provider',
    'model_reasoning_effort',
    'model_context_window',
    'model_verbosity',
    'model_reasoning_summary',
    'model_supports_reasoning_summaries'
  ]);

  for (const line of lines) {
    const tableName = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/)?.[1]?.trim();
    if (tableName) {
      skippingManagedTable = tableName === 'model_providers.agent-router' || tableName.startsWith('model_providers.');
      if (!skippingManagedTable) {
        kept.push(line);
      }
      continue;
    }
    if (skippingManagedTable) {
      continue;
    }

    const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
    if (key && managedTopLevelKeys.has(key)) {
      continue;
    }
    if (line.trim() === '# Managed by Agent Router') {
      continue;
    }
    kept.push(line);
  }

  return trimBlankLines(kept.join('\n'));
}

function stripJsonManagedConfig(
  content: string,
  options: { topLevelKeys: string[]; envKeys: string[]; leadingComma: boolean }
): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed)) {
      return '';
    }
    const cleaned = removeManagedJsonKeys(parsed, options);
    const keys = Object.keys(cleaned);
    if (keys.length === 0) {
      return '';
    }
	    const body = JSON.stringify(cleaned, null, 2).split('\n').slice(1, -1).join('\n');
	    return body ? `${options.leadingComma ? ',\n' : ''}${body}` : '';
  } catch {
    return '';
  }
}

function removeManagedJsonKeys(
  source: Record<string, unknown>,
  options: { topLevelKeys: string[]; envKeys: string[]; leadingComma: boolean }
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  const managedTopLevelKeys = new Set(options.topLevelKeys);
  const managedEnvKeys = new Set(options.envKeys);

  for (const [key, value] of Object.entries(source)) {
    if (managedTopLevelKeys.has(key)) {
      continue;
    }
    if (key === 'env' && isPlainObject(value)) {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimBlankLines(value: string): string {
  return value
    .split('\n')
    .join('\n')
    .trim();
}

function markProviderApplied(state: AppState, agentId: string): AppState {
  return {
    ...state,
    targets: state.targets.map((target) =>
      target.id === agentId
        ? { ...target, appliedProviderId: target.activeProviderId }
        : target
    )
  };
}

function formatApplyResult(result: ApplyResult): string {
  const backup = result.backupPath ? `，已备份 ${result.backupPath}` : '';
  const prompt = result.promptFilePath ? `，提示词 ${result.promptFilePath}` : '';
  return `${result.targetName} 已写入 ${result.bytes} bytes${backup}${prompt}`;
}

function AgentIcon({ id }: { id: string }): ReactElement {
  const logoByAgent: Record<string, string> = {
    codex: openaiLogo,
    claude: claudeLogo,
    gemini: geminiLogo
  };
  const logo = logoByAgent[id];

  if (logo) {
    return <img className="brand-logo" src={logo} alt="" aria-hidden="true" />;
  }

  return (
    <svg className="brand-logo fallback-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4h10l4 8-4 8H7l-4-8 4-8Z" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8 12h8" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function languageForPath(filePath: string): string {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith('.json')) return 'json';
  if (lowerPath.endsWith('.toml')) return 'toml';
  if (lowerPath.endsWith('.yaml') || lowerPath.endsWith('.yml')) return 'yaml';
  if (lowerPath.endsWith('.md')) return '';
  return 'text';
}

function MarkdownView({ content, emptyText, codeLanguage }: { content: string; emptyText: string; codeLanguage?: string }): ReactElement {
  if (!content.trim()) {
    return <div className="markdown-preview empty">{emptyText}</div>;
  }

  const markdown = codeLanguage ? `\`\`\`${codeLanguage}\n${content}\n\`\`\`` : content;
  return <div className="markdown-preview">{renderMarkdown(markdown)}</div>;
}

function renderMarkdown(markdown: string): ReactElement[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactElement[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre className="md-code" key={`code-${index}`}>
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(renderHeading(level, heading[2], `heading-${index}`));
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`}>{quoteLines.map((quoteLine, quoteIndex) => <p key={quoteIndex}>{renderInlineMarkdown(quoteLine)}</p>)}</blockquote>);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}</ul>);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}</ol>);
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^>\s?/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={`p-${index}`}>{renderInlineMarkdown(paragraphLines.join(' '))}</p>);
  }

  return blocks;
}

function renderHeading(level: number, text: string, key: string): ReactElement {
  if (level === 1) return <h1 key={key}>{renderInlineMarkdown(text)}</h1>;
  if (level === 2) return <h2 key={key}>{renderInlineMarkdown(text)}</h2>;
  if (level === 3) return <h3 key={key}>{renderInlineMarkdown(text)}</h3>;
  return <h4 key={key}>{renderInlineMarkdown(text)}</h4>;
}

function renderInlineMarkdown(text: string): Array<ReactElement | string> {
  const parts: Array<ReactElement | string> = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(<code key={`${match.index}-code`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      parts.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<em key={`${match.index}-em`}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export default App;
