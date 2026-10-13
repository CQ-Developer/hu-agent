import { contextBridge, ipcRenderer } from 'electron'

import type { AgentEvent } from '../shared/events'
import type { HuAgentApi } from '../shared/ipc'

const api: HuAgentApi = {
  getVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    saveProvider: (input) => ipcRenderer.invoke('settings:save-provider', input),
    removeProvider: (id) => ipcRenderer.invoke('settings:remove-provider', id),
    setDefault: (role, target) => ipcRenderer.invoke('settings:set-default', role, target),
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: () => ipcRenderer.invoke('sessions:create'),
    items: (sessionId) => ipcRenderer.invoke('sessions:items', sessionId),
    rename: (sessionId, title) => ipcRenderer.invoke('sessions:rename', sessionId, title),
    options: (sessionId) => ipcRenderer.invoke('sessions:options', sessionId),
    setOptions: (sessionId, options) => ipcRenderer.invoke('sessions:set-options', sessionId, options),
    stats: (sessionId) => ipcRenderer.invoke('sessions:stats', sessionId),
  },
  agent: {
    send: (sessionId, text) => ipcRenderer.invoke('agent:send', sessionId, text),
    cancel: (sessionId) => ipcRenderer.invoke('agent:cancel', sessionId),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: AgentEvent): void => listener(payload)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.removeListener('agent:event', handler)
    },
  },
  usage: {
    stats: () => ipcRenderer.invoke('usage:stats'),
  },
  workspace: {
    info: () => ipcRenderer.invoke('workspace:info'),
  },
}

contextBridge.exposeInMainWorld('huAgent', api)
