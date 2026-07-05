import type { AgentRouterApi } from '../../preload';

declare global {
  interface Window {
    agentRouter: AgentRouterApi;
  }
}
