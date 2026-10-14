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
    getLocale: () => ipcRenderer.invoke('settings:get-locale'),
    setLocale: (preference) => ipcRenderer.invoke('settings:set-locale', preference),
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: () => ipcRenderer.invoke('sessions:create'),
    items: (sessionId) => ipcRenderer.invoke('sessions:items', sessionId),
    rename: (sessionId, title) => ipcRenderer.invoke('sessions:rename', sessionId, title),
    options: (sessionId) => ipcRenderer.invoke('sessions:options', sessionId),
    setOptions: (sessionId, options) => ipcRenderer.invoke('sessions:set-options', sessionId, options),
    stats: (sessionId) => ipcRenderer.invoke('sessions:stats', sessionId),
    search: (query) => ipcRenderer.invoke('sessions:search', query),
  },
  agent: {
    send: (sessionId, text) => ipcRenderer.invoke('agent:send', sessionId, text),
    cancel: (sessionId) => ipcRenderer.invoke('agent:cancel', sessionId),
    decideApproval: (requestId, choice) => ipcRenderer.invoke('agent:decide-approval', requestId, choice),
    answerGuide: (requestId, value) => ipcRenderer.invoke('agent:answer-guide', requestId, value),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: AgentEvent): void => listener(payload)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.removeListener('agent:event', handler)
    },
  },
  usage: {
    stats: () => ipcRenderer.invoke('usage:stats'),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (name, scope, enabled) => ipcRenderer.invoke('skills:set-enabled', name, scope, enabled),
  },
  market: {
    list: (params) => ipcRenderer.invoke('market:list', params),
    detail: (skillId) => ipcRenderer.invoke('market:detail', skillId),
    install: (skillId, version) => ipcRenderer.invoke('market:install', skillId, version),
    uninstall: (skillId) => ipcRenderer.invoke('market:uninstall', skillId),
    installed: () => ipcRenderer.invoke('market:installed'),
    checkStatus: (force) => ipcRenderer.invoke('market:check-status', force),
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    now: () => ipcRenderer.invoke('sync:now'),
    versions: () => ipcRenderer.invoke('sync:versions'),
    restore: (version) => ipcRenderer.invoke('sync:restore', version),
    resolve: (choice) => ipcRenderer.invoke('sync:resolve', choice),
    pin: (snapshotId) => ipcRenderer.invoke('sync:pin', snapshotId),
    remove: (snapshotId) => ipcRenderer.invoke('sync:remove', snapshotId),
    settings: () => ipcRenderer.invoke('sync:get-settings'),
    setSettings: (settings) => ipcRenderer.invoke('sync:set-settings', settings),
    onEvent: (listener) => {
      const handler = (_event: unknown, view: Parameters<typeof listener>[0]): void => listener(view)
      ipcRenderer.on('sync:event', handler)
      return () => ipcRenderer.removeListener('sync:event', handler)
    },
  },
  stats: {
    usage: (params) => ipcRenderer.invoke('stats:usage', params),
    activations: (params) => ipcRenderer.invoke('stats:activations', params),
    teams: () => ipcRenderer.invoke('stats:teams'),
    orgs: () => ipcRenderer.invoke('stats:orgs'),
  },
  diagnostics: {
    export: () => ipcRenderer.invoke('diagnostics:export'),
  },
  permissions: {
    rules: () => ipcRenderer.invoke('permissions:rules'),
    audit: (limit?: number) => ipcRenderer.invoke('permissions:audit', limit),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    save: (input) => ipcRenderer.invoke('mcp:save', input),
    remove: (name, scope) => ipcRenderer.invoke('mcp:remove', name, scope),
    setEnabled: (name, scope, enabled) => ipcRenderer.invoke('mcp:set-enabled', name, scope, enabled),
    test: (name) => ipcRenderer.invoke('mcp:test', name),
  },
  cloud: {
    status: () => ipcRenderer.invoke('cloud:status'),
    session: () => ipcRenderer.invoke('cloud:session'),
    providers: (serverUrl: string) => ipcRenderer.invoke('cloud:providers', serverUrl),
    ssoLogin: (serverUrl: string, providerId: string) => ipcRenderer.invoke('cloud:sso-login', serverUrl, providerId),
    updateLocale: (locale) => ipcRenderer.invoke('cloud:update-locale', locale),
    exportData: () => ipcRenderer.invoke('cloud:export-data'),
    deleteAccount: (confirmEmail, password) => ipcRenderer.invoke('cloud:delete-account', confirmEmail, password),
    login: (serverUrl, email, password) => ipcRenderer.invoke('cloud:login', serverUrl, email, password),
    register: (serverUrl, email, displayName, password) =>
      ipcRenderer.invoke('cloud:register', serverUrl, email, displayName, password),
    logout: (allDevices) => ipcRenderer.invoke('cloud:logout', allDevices),
    devices: () => ipcRenderer.invoke('cloud:devices'),
    revokeDevice: (deviceId) => ipcRenderer.invoke('cloud:revoke-device', deviceId),
    flush: () => ipcRenderer.invoke('cloud:flush'),
    clearQueue: () => ipcRenderer.invoke('cloud:clear-queue'),
    onSessionLost: (listener) => {
      const handler = (_event: unknown, reason: string): void => listener(reason)
      ipcRenderer.on('cloud:session-lost', handler)
      return () => ipcRenderer.removeListener('cloud:session-lost', handler)
    },
  },
  workspace: {
    list: () => ipcRenderer.invoke('workspace:list'),
    active: () => ipcRenderer.invoke('workspace:active'),
    setActive: (id) => ipcRenderer.invoke('workspace:set-active', id),
    pick: () => ipcRenderer.invoke('workspace:pick'),
  },
}

contextBridge.exposeInMainWorld('huAgent', api)
