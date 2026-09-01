/**
 * translations — every user-facing string in this app, in every language it
 * ships. Studio's Content panel reads and writes this file directly.
 *
 * Add a key to BOTH locales. A key missing from `ar` falls back to nothing,
 * not to English, so an untranslated string shows as blank in Arabic.
 */
export const translations = {
  en: {
    home: {
      home: 'Home',
      startEditingThisPageIn: 'Start editing this page in Studio.'
    },
    sheet: {
      sheet: 'Sheet',
      oneQuestionOrOneThing: 'One question, or one thing to confirm. Replace this with what the sheet is for.'
    }
  },
  ar: {
    home: {
      home: 'الرئيسية',
      startEditingThisPageIn: 'ابدأ تحرير هذه الصفحة في Studio.'
    },
    sheet: {
      oneQuestionOrOneThing: 'سؤال واحد، أو أمر واحد للتأكيد. استبدل هذا بما وُجدت الورقة لأجله.',
      sheet: 'ورقة'
    }
  },
}

/** The locale codes this app declares. */
export type Locale = keyof typeof translations

/** The language used when nothing else has been chosen. */
export const defaultLocale: Locale = 'en'
