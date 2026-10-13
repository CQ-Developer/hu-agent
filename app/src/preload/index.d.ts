import type { HuAgentApi } from '../shared/ipc'

declare global {
  interface Window {
    huAgent: HuAgentApi
  }
}

export {}
