/**
 * translations — every user-facing string in this app, in every language it
 * ships. Studio's Content panel reads and writes this file directly.
 *
 * Add a key to BOTH locales. A key missing from `ar` falls back to nothing,
 * not to English, so an untranslated string shows as blank in Arabic.
 */
export const translations = {
  en: {
    sheetHeader: {
      back: 'Back'
    },
    cssProbe: {
      probe: 'probe',
      addYourTextHere: 'Add your text here.'
    },
    home: {
      home: 'Home',
      startEditingThisPageIn: 'Start editing this page in Studio.'
    },
    onboarding: {
      completeYourSetupDonT: 'Complete your setup. Don’t miss out on:',
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
      enterVerificationCode: 'Enter Verification Code',
      enterThe6DigitCode: 'Enter the 6-digit code sent via:',
      sms: 'SMS',
      at: 'at',
      resendIn: 'Resend in',
      _29Seconds: '29 seconds'
    }
  },
  ar: {
    cssProbe: {
      addYourTextHere: 'أضف نصك هنا.',
      probe: 'probe'
    },
    home: {
      home: 'الرئيسية',
      startEditingThisPageIn: 'ابدأ تحرير هذه الصفحة في Studio.'
    },
    onboarding: {
      agree: 'موافق',
      and: '، و',
      byClickingAgreeIConsent: 'بالنقر على موافق، أوافق على تلقي الاتصالات وأقرّ بـ',
      completeYourSetupDonT: 'أكمل إعدادك. لا تفوّت:',
      flashSales: 'عروض خاطفة',
      maybeLater: 'ربما لاحقًا',
      offersPickedForYou: 'عروض مختارة لك',
      priceDropsBeforeTheyAre: 'انخفاضات الأسعار قبل نفادها',
      privacyPolicy: 'سياسة الخصوصية',
      termsAndConditions: 'الشروط والأحكام',
      uniqueRatesViaWhatsappEmail: 'أسعار حصرية عبر واتساب والبريد والرسائل النصية!',
      youCanOptOutAnytime: 'يمكنك إلغاء الاشتراك في أي وقت.'
    },
    sheetHeader: {
      back: 'رجوع'
    },
    signUp: {
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
      at: 'على',
      enterThe6DigitCode: 'أدخل الرمز المكوّن من 6 أرقام المُرسل عبر:',
      enterVerificationCode: 'أدخل رمز التحقق',
      resendIn: 'إعادة الإرسال خلال',
      sms: 'رسالة نصية'
    }
  },
}

/** The locale codes this app declares. */
export type Locale = keyof typeof translations

/** The language used when nothing else has been chosen. */
export const defaultLocale: Locale = 'en'
