import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export type AppLocale = 'en' | 'zh-CN';

export const SUPPORTED_LOCALES: AppLocale[] = ['en', 'zh-CN'];

const STORAGE_KEY = 'dicomassist-locale';

function detectInitialLocale(): AppLocale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh-CN') return saved;
  } catch { /* ignore */ }
  // Fall back to browser language
  const nav = navigator.language?.toLowerCase() ?? '';
  if (nav.startsWith('zh')) return 'zh-CN';
  return 'en';
}

export function setLocale(locale: AppLocale): void {
  i18n.changeLanguage(locale);
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch { /* ignore */ }
}

export function getCurrentLocale(): AppLocale {
  return (i18n.language as AppLocale) ?? 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-CN': { translation: zhCN },
  },
  lng: detectInitialLocale(),
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes
  },
  returnNull: false,
});

export default i18n;
