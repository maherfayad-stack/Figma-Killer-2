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
      almosafer: 'Almosafer',
      whereToNext: 'Where to next?',
      flights: 'Flights',
      stays: 'Stays',
      cars: 'Cars',
      from: 'From',
      to: 'To',
      dates: 'Dates',
      travellersClass: 'Travellers & class',
      searchFlights: 'Search flights',
      skipTheTaxiQueue: 'Skip the taxi queue',
      bookAnAirportTransferAnd: 'asdasdasda',
      bookATransfer: 'Book a transfer',
      dubaiDxb: 'Dubai (DXB)',
      jeddahJed: 'Jeddah (JED)',
      _1128Aug: '11 – 28 Aug',
      _2AdultsEconomy: '2 adults · Economy',
      asdfasdfasdfasd: 'asdfasdfasdfasd'
    },
    page: {
      account: 'Account',
      profileVerified: 'Profile verified',
      yourIdentityHasBeenConfirmed: 'Your identity has been confirmed and you\'re ready to book.',
      addYourTextHere: 'Add your text here.',
      preferences: 'Preferences',
      pushNotifications: 'Push notifications',
      darkAppearance: 'Dark appearance',
      language: 'Language',
      currency: 'Currency',
      support: 'Support',
      helpCentre: 'Help centre',
      contactUs: 'Contact us',
      termsPrivacy: 'Terms & privacy',
      signOut: 'Sign out',
      asdasdasdas: 'asdasdasdas',
      asdasda: 'asdasda',
      english: 'English',
      sar: 'SAR'
    }
  },
  ar: {
    home: {
      almosafer: 'مليبلميبل',
      bookAnAirportTransferAnd: 'احجز توصيلة المطار وصل بلا توتر',
      bookATransfer: 'احجز توصيلة',
      cars: 'سيارات',
      dates: 'التواريخ',
      flights: 'طيران',
      from: 'من',
      searchFlights: 'ابحث عن رحلات',
      skipTheTaxiQueue: 'تخطَّ طابور التاكسي',
      stays: 'إقامات',
      to: 'إلى',
      travellersClass: 'المسافرون والدرجة',
      whereToNext: 'إلى أين بعد؟',
      _1128Aug: 'يبلنوسيبلكم',
      _2AdultsEconomy: 'بالغان · اقتصادي',
      asdfasdfasdfasd: 'اي كلام',
      dubaiDxb: 'دبي (DXB)',
      jeddahJed: 'جدة (JED)'
    },
    page: {
      account: 'الحساب',
      addYourTextHere: 'أضف نصك هنا.',
      contactUs: 'تواصل معنا',
      currency: 'العملة',
      darkAppearance: 'المظهر الداكن',
      helpCentre: 'مركز المساعدة',
      language: 'اللغة',
      preferences: 'التفضيلات',
      profileVerified: 'تم التحقق من الملف',
      pushNotifications: 'الإشعارات',
      signOut: 'تسجيل الخروج',
      support: 'الدعم',
      termsPrivacy: 'الشروط والخصوصية',
      yourIdentityHasBeenConfirmed: 'تم تأكيد هويتك وأنت جاهز للحجز.',
      asdasda: 'اي كلام',
      asdasdasdas: 'اي كلام',
      english: 'الإنجليزية',
      sar: 'ر.س'
    }
  },
}

/** The locale codes this app declares. */
export type Locale = keyof typeof translations

/** The language used when nothing else has been chosen. */
export const defaultLocale: Locale = 'en'
