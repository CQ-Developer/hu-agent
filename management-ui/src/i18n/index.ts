import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import enUS from './locales/en-US'
import zhCN from './locales/zh-CN'

const saved = localStorage.getItem('huagent.locale')
const initial = saved === 'en-US' ? 'en-US' : 'zh-CN'

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: initial,
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
})

i18n.on('languageChanged', (language) => localStorage.setItem('huagent.locale', language))

export default i18n
