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
    onboarding: {
      completeYourSetupDonRsquo: 'Complete your setup. Don&rsquo;t miss out on:',
      uniqueRatesViaWhatsappEmail: 'Unique rates via WhatsApp, email, and SMS!',
      priceDropsBeforeTheyAre: 'Price drops before they are gone',
      flashSales: 'Flash sales',
      offersPickedForYou: 'Offers picked for you',
      agree: 'Agree',
      maybeLater: 'Maybe later',
      byClickingAgreeIConsent: 'By clicking Agree, I consent to receiving communications and acknowledge the',
      privacyPolicy: 'privacy policy',
      and: ', and',
      termsAndConditions: 'terms and conditions',
      youCanOptOutAnytime: 'You can opt-out anytime.'
    },
    signUp: {
      back: 'Back',
      signInOrCreateAccount: 'Sign in or create account',
      code: 'Code',
      mobileNumber: 'Mobile number',
      continue: 'Continue',
      registerAsABusiness: 'Register as a Business',
      continueWithEmail: 'Continue with email',
      continueWithApple: 'Continue with Apple',
      continueWithGoogle: 'Continue with Google'
    },
    sMS: {
      back: 'Back',
      enterVerificationCode: 'Enter Verification Code',
      enterThe6DigitCode: 'Enter the 6-digit code sent via:',
      smsAt96655333: 'SMS at +966 55 333 4444',
      nbsp: '&nbsp;',
      resendIn: 'Resend in',
      _29Seconds: '29 seconds'
    }
  },
  ar: {
    home: {
      home: 'الرئيسية',
      startEditingThisPageIn: 'ابدأ تحرير هذه الصفحة في Studio.'
    },
    onboarding: {
      agree: 'موافق',
      and: '، و',
      byClickingAgreeIConsent: 'بالنقر على موافق، أوافق على تلقي الاتصالات وأقرّ بـ',
      completeYourSetupDonRsquo: 'أكمل إعدادك. لا تفوّت:',
      flashSales: 'عروض خاطفة',
      maybeLater: 'ربما لاحقًا',
      offersPickedForYou: 'عروض مختارة لك',
      priceDropsBeforeTheyAre: 'انخفاضات الأسعار قبل نفادها',
      privacyPolicy: 'سياسة الخصوصية',
      termsAndConditions: 'الشروط والأحكام',
      uniqueRatesViaWhatsappEmail: 'أسعار حصرية عبر واتساب والبريد والرسائل النصية!',
      youCanOptOutAnytime: 'يمكنك إلغاء الاشتراك في أي وقت.'
    },
    signUp: {
      back: 'رجوع',
      code: 'الرمز',
      continue: 'متابعة',
      continueWithApple: 'المتابعة عبر Apple',
      continueWithEmail: 'المتابعة بالبريد الإلكتروني',
      continueWithGoogle: 'المتابعة عبر Google',
      mobileNumber: 'رقم الجوال',
      registerAsABusiness: 'التسجيل كشركة',
      signInOrCreateAccount: 'سجّل الدخول أو أنشئ حسابًا'
    },
    sMS: {
      _29Seconds: '29 ثانية',
      back: 'رجوع',
      enterThe6DigitCode: 'أدخل الرمز المكوّن من 6 أرقام المُرسل عبر:',
      enterVerificationCode: 'أدخل رمز التحقق',
      nbsp: '&nbsp;',
      resendIn: 'إعادة الإرسال خلال',
      smsAt96655333: 'رسالة نصية على ‎+966 55 333 4444'
    }
  },
}

/** The locale codes this app declares. */
export type Locale = keyof typeof translations

/** The language used when nothing else has been chosen. */
export const defaultLocale: Locale = 'en'
