import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { translations } from './translations'
import { getUrlParam } from '../urlState'

const LanguageContext = createContext(null)

export function LanguageProvider({ children }) {
  const [lang, setLang] = useState(() => (getUrlParam('lang') === 'ar' ? 'ar' : 'en'))

  const toggleLang = useCallback(() => {
    setLang((l) => (l === 'en' ? 'ar' : 'en'))
  }, [])

  const value = useMemo(
    () => ({
      lang,
      dir: lang === 'ar' ? 'rtl' : 'ltr',
      t: translations[lang],
      setLang,
      toggleLang,
    }),
    [lang, toggleLang],
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider')
  return ctx
}
