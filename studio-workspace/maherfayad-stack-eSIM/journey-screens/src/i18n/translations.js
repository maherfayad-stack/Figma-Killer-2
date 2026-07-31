// Arabic copy written per the almosafer-arabic-translation skill: فصحى مبسطة,
// action-first for buttons, light passive / نحن-active instead of تم + مصدر,
// canonical Almosafer product terms (eSIM → شريحة إلكترونية, Stays → الإقامة, …).

function daysLeftAr(n) {
  if (n === 1) return 'تبقّى يوم واحد'
  if (n === 2) return 'تبقّى يومان'
  if (n >= 3 && n <= 10) return `تبقّت ${n} أيام`
  return `تبقّى ${n} يومًا`
}

function gbLeftAr(n) {
  return `تبقّى ${n} جيجا`
}

function daysLeftEn(n) {
  return `${n} day${n === 1 ? '' : 's'} left`
}

function gbLeftEn(n) {
  return `${n} GB left`
}

function gbLeftOfEn(left, total) {
  return `${left} GB of ${total} GB left`
}

function gbLeftOfAr(left, total) {
  return `تبقّى ${left} جيجا من أصل ${total} جيجا`
}

function installedCountEn(count, total) {
  return `${count} / ${total} Installed`
}

function installedCountAr(count, total) {
  return `${count} من ${total} مثبّتة`
}

function daysPlainAr(n) {
  if (n === 1) return 'يوم واحد'
  if (n === 2) return 'يومان'
  if (n >= 3 && n <= 10) return `${n} أيام`
  return `${n} يومًا`
}

function percentRemainingEn(percent, days) {
  return `${percent}% remaining · ${days} day${days === 1 ? '' : 's'}`
}

function percentRemainingAr(percent, days) {
  return `متبقٍ ${percent}% · ${daysPlainAr(days)}`
}

function gbFractionEn(left, total) {
  return `${left}/${total} GB`
}

function gbFractionAr(left, total) {
  return `${left}/${total} جيجا`
}

export const translations = {
  en: {
    common: {
      close: 'Close',
      copy: 'Copy',
      share: 'Share',
      install: 'Install',
      topup: 'Topup',
      dataTabLabel: 'Data',
      turnOnData: 'Turn on data',
      confirm: 'Confirm',
      moreInformation: 'More information',
      faqTitle: 'Frequently Asked Questions (FAQs)',
      faqSubtext: 'Browse through on popular help topics',
      needHelp: 'Need help',
      esimActivationTitle: 'eSIM Activation',
      esimLabel: 'eSIM',
      esimChecklist: [
        'Only an eSIM is provided for internet use; no physical SIM card or calls.',
        'Requires an internet connection',
        'Your package starts counting from the day you travel',
      ],
      confirmed: 'Confirmed',
      roundTrip: 'Round-trip',
      viewAll: 'View all',
      gbLeft: gbLeftEn,
      daysLeft: daysLeftEn,
      gbLeftOf: gbLeftOfEn,
      installedCount: installedCountEn,
      percentRemaining: percentRemainingEn,
      gbFraction: gbFractionEn,
    },
    tabBar: {
      home: 'Home',
      explore: 'Explore',
      myTrips: 'My Trips',
      topOffers: 'Top offers',
      profile: 'Profile',
    },
    homepage: {
      greeting: 'Hi Muhammad',
      prompt: 'What will you explore next?',
      almosaferPoints: 'Almosafer Points',
      flights: 'Flights',
      stays: 'Stays',
      activities: 'Activities',
      airportTransfers: 'Airport Transfers',
      haramainTrain: 'Haramain Train',
      sixFlagsQiddiya: 'Six Flags Qiddiya City',
      seeMore: 'See more',
      esimBannerTitle: '2 eSIMs for your trip to London to install',
      esimBannerDesc: 'Install before you fly.',
      esimLowBannerTitle: 'London eSIM · running low',
      upcomingTrip: 'Upcoming trip',
      london: 'London',
      londonDates: '16 Dec 2025 - 1 Jan 2026',
      hotelName: 'Pullman London St Pancras Excelsior Resort',
      enhanceYourTrip: 'ENHANCE YOUR TRIP',
      addonTransferTitle: 'Airport transfer',
      addonTransferSubtitle: 'A driver meets you at arrivals and takes you straight to your hotel.',
      addonInsuranceTitle: 'Travel insurance',
      addonInsuranceSubtitle: 'Cover medical emergencies, delays and lost baggage on your trip.',
      findActivities: 'Find activities in London',
      bookTours: 'Book incredible tours, events and activities',
      specialDeals: 'Special deals for you',
      code: 'Code',
      deals: {
        deal1: 'End the season on a high note',
        deal2: 'Check in before the season checks out',
        deal3: 'Embark on a serene Umrah',
        deal4: 'Travel in comfort & style!',
      },
    },
    bookingConfirmation: {
      title: 'Booking confirmed',
      heading: 'Your booking is confirmed',
      subtitle: 'Round-trip | RUH to CAI | Feb - 10 Feb',
      bookingDetails: 'Booking details',
      completeYourTrip: 'Complete your trip',
      hotelsTag: 'Exclusive rates on hotels',
      hotelsTitle: 'Enjoy 12% discount on hotels',
      hotelsSubtitle: 'Special hotel deals with your flight booking.',
      useCode: 'Use code',
      viewHotels: 'View hotels',
      taxiTitle: 'Skip the Taxi Queue',
      taxiSubtitle: 'Your professional driver will be waiting at arrivals to take you straight to your door.',
      forAllTravellers: 'For all travellers',
      reserveNow: 'Reserve now',
      purchasedAddons: 'Purchased add-ons',
      esimSubtext: 'You still need to install it to be able to use.',
      autoCheckIn: 'Auto Check-in',
      baggageProtection: 'Baggage Protection',
      rewards: 'Rewards',
      mokafaaPoints: "15,000 Mokafa'a points",
      mobileNumber: 'Mobile number: +966 55 666 7777',
      rewardsNote: 'Your points will be rewarded 14 days after your departure or check-in date.',
      paymentDetails: 'Payment details',
      paymentTotal: 'Total: SAR 1,500 (incl. VAT)',
    },
    bookingDetails: {
      title: 'Your booking',
      bannerTitle: '2 eSIMs for your trip to London to install',
      bannerDesc: 'Install before you fly.',
      lowBannerTitle: 'London eSIM · running low',
      dataOffBannerTitle: 'London eSIM · data is off',
      dataOffBannerDesc: "You won't use data until it's turned on.",
      dataOffStatLabel: 'Data is off',
      dataOffCardSubtitle: 'Mobile data is switched off for this eSIM.',
      route: 'JED to RUH',
      dates: '11 Aug 2024 - 18 Aug 2024',
      adults: '2 x Adults',
      almosaferId: 'Almosafer ID',
      airlineReference: 'Airline Reference (PNR)',
      segmentRoute: 'Jeddah to Riyadh',
      purchasedAddons: 'Purchased add-ons',
      gbTag: '5 GB',
      installNowLong: 'Install now. Validity starts once it connects to a network for the first time.',
      moreAbout: (label) => `More about ${label}`,
    },
    activateIntro: {
      stepLabel: 'Step 1 of 3 · Prepare',
      heading: 'Install your eSIM in just a few steps',
      installEsim: 'Install eSIM',
    },
    onboardingIntro: {
      next: 'Next',
      installNow: 'Install Now',
      slides: [
        {
          heading: 'No SIM to swap',
          desc: 'Your eSIM lives inside your phone. No physical SIM card is provided.',
        },
        {
          heading: 'Internet Needed',
          desc: 'Connect to Wi-Fi or data to install it before you travel.',
        },
        {
          heading: 'Starts on travel day',
          desc: 'Install anytime, your package only starts counting from the day you travel.',
        },
      ],
    },
    activateSettings: {
      stepLabel: 'Step 2 of 3 · Install',
      heading: 'Install from settings',
      subtext: 'Tap "Activate" in the popup that opens. Your carrier confirms it instantly.',
      openSettings: 'Open Settings',
      manualEntry: 'Enter details manually',
      configuring: 'Installing eSIM',
      phases: ['Verifying device…', 'Installing eSIM profile…', 'Almost there…'],
      cellularPopupAlt: 'iOS Settings — Activate Your eSIM popup',
      connectingAlt: 'iOS Settings — Connecting to carrier',
    },
    manualEntry: {
      title: 'Add eSIM manually',
      description: "Can't install automatically? Enter these details in Settings → Add eSIM manually.",
      smdpLabel: 'SM-DP+ address',
      smdpValue: 'rsp.almosafer.smdp.io',
      activationLabel: 'Activation code',
      activationValue: 'LPA:1$rsp...$AB12CD',
      activationHelper: "Each code works once. If you've already installed, request a new code before trying again",
      copiedMessage: 'Copied to clipboard',
    },
    esimData: {
      moreInfoLabel: 'Data is switched off?',
      moreInfoSubtext: 'Steps to turn it on manually',
      title: 'eSIM Data',
      heading: 'Data is switched off',
      subtext: 'Last we checked, mobile data for London eSIM was off on your device.',
      steps: [
        'Settings → Mobile Data → London eSIM',
        'Turn on',
        'Turn on Data Roaming',
      ],
      confirm: "I've turned it on",
      contact: 'Still not working? Contact support',
    },
    devicePicker: {
      title: 'Where do you want to install this eSIM?',
      thisDevice: 'This device',
      anotherDevice: 'Another device',
    },
    topupPackage: {
      title: 'Choose a package',
      dataTab: 'Data',
      daysTab: 'Days',
      gbLabel: (gb) => `${gb} GB`,
      daysLabel: (days) => `+${days} Day${days === 1 ? '' : 's'}`,
      priceLabel: (price) => `SAR ${price}`,
    },
    esimSuccess: {
      activateStepLabel: 'Step 3 of 3 · Done',
      activateHeading: 'Your eSIM is installed',
      activateDetail: '1 GB | 30 days',
      topupHeading: 'Your eSIM has been topped up',
      topupDetailGb: (gb) => `${gb} GB added`,
      topupDetailDays: (days) => `+${days} Day${days === 1 ? '' : 's'} added`,
      primaryAction: 'Booking details',
    },
    qrCode: {
      caption: 'Open your camera on the other device and point it at this code',
      heading: 'Install on another device',
      subtext: 'Scan the QR code with the other device and follow the on-screen instructions.',
      doneLabel: 'Done',
      qrAlt: 'QR code',
    },
    topup: {
      paymentAlt: 'Confirm and Pay',
    },
  },

  ar: {
    common: {
      close: 'إغلاق',
      copy: 'نسخ',
      share: 'مشاركة',
      install: 'تثبيت',
      topup: 'شحن',
      dataTabLabel: 'البيانات',
      turnOnData: 'تفعيل البيانات',
      confirm: 'تأكيد',
      moreInformation: 'معلومات إضافية',
      faqTitle: 'الأسئلة الشائعة',
      faqSubtext: 'تصفّح أكثر مواضيع المساعدة شيوعًا',
      needHelp: 'بحاجة إلى مساعدة',
      esimActivationTitle: 'تفعيل الشريحة الإلكترونية',
      esimLabel: 'شريحة إلكترونية',
      esimChecklist: [
        'شريحة إلكترونية فقط، دون شريحة فعلية',
        'تحتاج إلى اتصال بالإنترنت',
        'تبدأ باقتك بالعد من يوم سفرك',
      ],
      confirmed: 'مؤكد',
      roundTrip: 'ذهاب وعودة',
      viewAll: 'عرض الكل',
      gbLeft: gbLeftAr,
      daysLeft: daysLeftAr,
      gbLeftOf: gbLeftOfAr,
      installedCount: installedCountAr,
      percentRemaining: percentRemainingAr,
      gbFraction: gbFractionAr,
    },
    tabBar: {
      home: 'الرئيسية',
      explore: 'استكشاف',
      myTrips: 'رحلاتي',
      topOffers: 'أفضل العروض',
      profile: 'حسابي',
    },
    homepage: {
      greeting: 'مرحبًا، محمد',
      prompt: 'ما الذي تريد استكشافه اليوم؟',
      almosaferPoints: 'نقاط المسافر',
      flights: 'رحلات الطيران',
      stays: 'الإقامة',
      activities: 'الأنشطة',
      airportTransfers: 'توصيل المطار',
      haramainTrain: 'قطار الحرمين',
      sixFlagsQiddiya: 'سِكس فلاغز قدية',
      seeMore: 'عرض المزيد',
      esimBannerTitle: 'شريحتان إلكترونيتان لرحلتك إلى لندن بانتظار التثبيت',
      esimBannerDesc: 'ثبّتهما قبل السفر.',
      esimLowBannerTitle: 'شريحة لندن · بياناتها منخفضة',
      upcomingTrip: 'رحلتك القادمة',
      london: 'لندن',
      londonDates: '16 ديسمبر 2025 - 1 يناير 2026',
      hotelName: 'Pullman London St Pancras Excelsior Resort',
      enhanceYourTrip: 'عزّز رحلتك',
      addonTransferTitle: 'توصيل من المطار',
      addonTransferSubtitle: 'سائق بانتظارك عند الوصول ليأخذك مباشرة إلى فندقك.',
      addonInsuranceTitle: 'تأمين السفر',
      addonInsuranceSubtitle: 'تغطية الطوارئ الطبية والتأخير وفقدان الأمتعة خلال رحلتك.',
      findActivities: 'اكتشف الأنشطة في لندن',
      bookTours: 'احجز جولات وفعاليات وأنشطة رائعة',
      specialDeals: 'عروض خاصة لك',
      code: 'الكود',
      deals: {
        deal1: 'اختتم الموسم بأفضل طريقة',
        deal2: 'سجّل إقامتك قبل نهاية الموسم',
        deal3: 'انطلق في رحلة عمرة هادئة',
        deal4: 'سافر براحة وأناقة!',
      },
    },
    bookingConfirmation: {
      title: 'الحجز مؤكد',
      heading: 'حجزك مؤكد',
      subtitle: 'ذهاب وعودة | الرياض إلى القاهرة | فبراير - 10 فبراير',
      bookingDetails: 'تفاصيل الحجز',
      completeYourTrip: 'أكمل رحلتك',
      hotelsTag: 'أسعار حصرية على الفنادق',
      hotelsTitle: 'استمتع بخصم 12% على الفنادق',
      hotelsSubtitle: 'عروض فندقية خاصة مع حجز رحلتك.',
      useCode: 'استخدم الكود',
      viewHotels: 'عرض الفنادق',
      taxiTitle: 'تخطَّ طابور التاكسي',
      taxiSubtitle: 'سينتظرك سائق محترف عند صالة الوصول ليوصلك مباشرة إلى باب منزلك.',
      forAllTravellers: 'لجميع المسافرين',
      reserveNow: 'احجز الآن',
      purchasedAddons: 'الإضافات المشتراة',
      esimSubtext: 'لا تزال بحاجة إلى تثبيتها لاستخدامها',
      autoCheckIn: 'تسجيل الوصول التلقائي',
      baggageProtection: 'حماية الأمتعة',
      rewards: 'المكافآت',
      mokafaaPoints: '15,000 نقطة مكافأة',
      mobileNumber: 'رقم الجوال: ‎+966 55 666 7777',
      rewardsNote: 'تُضاف نقاطك خلال 14 يومًا من تاريخ مغادرتك أو تسجيل وصولك.',
      paymentDetails: 'تفاصيل الدفع',
      paymentTotal: 'الإجمالي: 1,500 ر.س (شامل الضريبة)',
    },
    bookingDetails: {
      title: 'حجزك',
      bannerTitle: 'شريحتان إلكترونيتان لرحلتك إلى لندن بانتظار التثبيت',
      bannerDesc: 'ثبّتهما قبل السفر.',
      lowBannerTitle: 'شريحة لندن · بياناتها منخفضة',
      dataOffBannerTitle: 'شريحة لندن · البيانات مغلقة',
      dataOffBannerDesc: 'لن تعمل بياناتك حتى تُفعَّل.',
      dataOffStatLabel: 'البيانات مغلقة',
      dataOffCardSubtitle: 'بيانات الجوال مغلقة لهذه الشريحة.',
      route: 'جدة إلى الرياض',
      dates: '11 أغسطس 2024 - 18 أغسطس 2024',
      adults: '2 × بالغين',
      almosaferId: 'رقم المسافر المرجعي',
      airlineReference: 'الرقم المرجعي للطيران (PNR)',
      segmentRoute: 'جدة إلى الرياض',
      purchasedAddons: 'الإضافات المشتراة',
      gbTag: '5 جيجا',
      installNowLong: 'ثبّتها الآن. تبدأ صلاحيتها بمجرد اتصالها بالشبكة لأول مرة.',
      moreAbout: (label) => `المزيد حول ${label}`,
    },
    activateIntro: {
      stepLabel: 'الخطوة 1 من 3 · التحضير',
      heading: 'فعّل شريحتك الإلكترونية في خطوات بسيطة',
      installEsim: 'تثبيت الشريحة',
    },
    onboardingIntro: {
      next: 'التالي',
      installNow: 'ثبّت الآن',
      slides: [
        {
          heading: 'لا حاجة لاستبدال الشريحة',
          desc: 'شريحتك الإلكترونية داخل هاتفك، دون الحاجة إلى شريحة مادية.',
        },
        {
          heading: 'الاتصال بالإنترنت مطلوب',
          desc: 'اتصل بشبكة واي فاي أو بيانات الجوال لتثبيتها قبل السفر.',
        },
        {
          heading: 'تبدأ يوم السفر',
          desc: 'ثبّتها في أي وقت، فباقتك تبدأ من يوم سفرك فقط.',
        },
      ],
    },
    activateSettings: {
      stepLabel: 'الخطوة 2 من 3 · التثبيت',
      heading: 'ثبّت من الإعدادات',
      subtext: 'اضغط على «تفعيل» في النافذة التي تظهر. يؤكدها مشغّل شبكتك فورًا.',
      openSettings: 'فتح الإعدادات',
      manualEntry: 'إدخال التفاصيل يدويًا',
      configuring: 'جارٍ إعداد الشريحة',
      phases: ['جارٍ التحقق من الجهاز…', 'جارٍ تثبيت ملف الشريحة…', 'أوشكنا على الانتهاء…'],
      cellularPopupAlt: 'إعدادات iOS — نافذة تفعيل الشريحة الإلكترونية',
      connectingAlt: 'إعدادات iOS — جارٍ الاتصال بمشغّل الشبكة',
    },
    manualEntry: {
      title: 'إضافة الشريحة يدويًا',
      description: 'لم يعمل التثبيت التلقائي؟ أدخل هذه البيانات في الإعدادات ← إضافة شريحة يدويًا.',
      smdpLabel: 'عنوان SM-DP+',
      smdpValue: 'rsp.almosafer.smdp.io',
      activationLabel: 'رمز التفعيل',
      activationValue: 'LPA:1$rsp...$AB12CD',
      activationHelper: 'يُستخدم كل رمز مرة واحدة. إذا ثبّتّ الشريحة سابقًا، اطلب رمزًا جديدًا قبل المحاولة مجددًا.',
      copiedMessage: 'نُسخ إلى الحافظة',
    },
    esimData: {
      moreInfoLabel: 'البيانات مغلقة؟',
      moreInfoSubtext: 'خطوات تفعيلها يدويًا',
      title: 'بيانات الشريحة',
      heading: 'بياناتك مغلقة',
      subtext: 'لاحظنا أن بيانات شريحة لندن مغلقة على جهازك.',
      steps: [
        'الإعدادات ← بيانات الجوال ← شريحة لندن',
        'تفعيل',
        'تفعيل تجوال البيانات',
      ],
      confirm: 'فعّلتها',
      contact: 'لم تُحل المشكلة؟ تواصل مع الدعم',
    },
    devicePicker: {
      title: 'أين تريد تثبيت هذه الشريحة؟',
      thisDevice: 'هذا الجهاز',
      anotherDevice: 'جهاز آخر',
    },
    topupPackage: {
      title: 'اختر باقة',
      dataTab: 'بيانات',
      daysTab: 'أيام إضافية',
      gbLabel: (gb) => `${gb} جيجا`,
      daysLabel: (days) => daysPlainAr(days),
      priceLabel: (price) => `${price} ر.س`,
    },
    esimSuccess: {
      activateStepLabel: 'الخطوة 3 من 3 · تم',
      activateHeading: 'شريحتك مثبّتة',
      activateDetail: '1 جيجا | 30 يومًا',
      topupHeading: 'تم شحن شريحتك بنجاح',
      topupDetailGb: (gb) => `أضفنا ${gb} جيجا`,
      topupDetailDays: (days) => `أضفنا ${daysPlainAr(days)}`,
      primaryAction: 'تفاصيل الإضافة',
    },
    qrCode: {
      caption: 'افتح الكاميرا على الجهاز الآخر ووجّهها نحو هذا الرمز',
      heading: 'التثبيت على جهاز آخر',
      subtext: 'امسح رمز QR بجهاز آخر واتبع التعليمات التي تظهر على الشاشة.',
      doneLabel: 'تم',
      qrAlt: 'رمز QR',
    },
    topup: {
      paymentAlt: 'تأكيد والدفع',
    },
  },
}
