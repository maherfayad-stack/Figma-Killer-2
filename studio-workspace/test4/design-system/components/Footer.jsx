import { useDir } from '../context/DesignSystemContext'
import { Separator } from './Separator'
import { Button } from './Button'
import { AlmosaferLogo } from './AlmosaferLogo'

// Reused design-system line icons — tinted via currentColor (white on the dark
// app card, gold for the rating stars, aqua for the PWA contact rows).
import phoneRaw from '../icons/line-icons/phone.svg?raw'
import whatsappRaw from '../icons/line-icons/whatsapp.svg?raw'
import storeRaw from '../icons/line-icons/store.svg?raw'
import starRaw from '../icons/line-icons/star.svg?raw'
import globeRaw from '../icons/line-icons/globe.svg?raw'

// Footer-local brand marks (third-party / national assets the design system
// deliberately keeps out of its intent-based icon set). Inlined as data URIs.
import barcodeUrl from '../icons/footer/barcode.png'
import appStoreUrl from '../icons/footer/app-store.png'
import googlePlayUrl from '../icons/footer/google-play.svg'
import huaweiUrl from '../icons/footer/huawei-appgallery.svg'
import awardsUrl from '../icons/footer/world-travel-awards.svg'
// payment marks reused from the shared logotypes set
import payMadaUrl from '../icons/logotypes/payment/mada.svg'
import payVisaUrl from '../icons/logotypes/payment/visa.svg'
import payMastercardUrl from '../icons/logotypes/payment/mastercard.svg'
import payAmexUrl from '../icons/logotypes/payment/amex.svg'
import payApplePayUrl from '../icons/logotypes/payment/applepay.svg'
import payStcpayUrl from '../icons/logotypes/payment/stcpay.svg'
import payMokafaaUrl from '../icons/logotypes/payment/mokafaa.svg'
import payQitafUrl from '../icons/logotypes/payment/qitaf.svg'
import fbUrl from '../icons/logotypes/social/facebook.svg'
import igUrl from '../icons/logotypes/social/instagram.svg'
import twitterUrl from '../icons/logotypes/social/x.svg'
import youtubeUrl from '../icons/logotypes/social/youtube.svg'
import linkedinUrl from '../icons/logotypes/social/linkedin.svg'
import snapchatUrl from '../icons/logotypes/social/snapchat.svg'
import flagSaUrl from '../icons/logotypes/flags/sa.svg'
import flagAeUrl from '../icons/logotypes/flags/ae.svg'
import flagKwUrl from '../icons/logotypes/flags/kw.svg'
import flagBhUrl from '../icons/logotypes/flags/bh.svg'
import flagOmUrl from '../icons/logotypes/flags/om.svg'
import flagQaUrl from '../icons/logotypes/flags/qa.svg'
import flagEgUrl from '../icons/logotypes/flags/eg.svg'

import './Footer.css'

// Inline raw svg (uses currentColor) inside a sized box, like the other components.
const RawIcon = ({ svg, className }) => (
  <span
    aria-hidden="true"
    className={className}
    dangerouslySetInnerHTML={{ __html: svg }}
  />
)

const FlagIcon = ({ src }) => <img className="footer__flag" src={src} alt="" aria-hidden="true" />
const SocialIcon = ({ src }) => <img className="footer__social-icon" src={src} alt="" aria-hidden="true" />

const isSocial = (col) => col.kind === 'social' || /social/i.test(col.title)

// ── Almosafer defaults ───────────────────────────────────────────────────────
// Every section is overridable via props. Text defaults are dir-aware: English
// for ltr, Arabic for rtl (like Separator / Search / Expander). The icon, flag,
// social, badge, and payment assets are language-independent and shared below.

const SOCIAL = {
  facebook: <SocialIcon src={fbUrl} />,
  instagram: <SocialIcon src={igUrl} />,
  x: <SocialIcon src={twitterUrl} />,
  youtube: <SocialIcon src={youtubeUrl} />,
  linkedin: <SocialIcon src={linkedinUrl} />,
  snapchat: <SocialIcon src={snapchatUrl} />,
}

const FLAG = {
  sa: <FlagIcon src={flagSaUrl} />,
  kw: <FlagIcon src={flagKwUrl} />,
  ae: <FlagIcon src={flagAeUrl} />,
  eg: <FlagIcon src={flagEgUrl} />,
  bh: <FlagIcon src={flagBhUrl} />,
  om: <FlagIcon src={flagOmUrl} />,
  qa: <FlagIcon src={flagQaUrl} />,
  ww: <RawIcon svg={globeRaw} className="footer__flag footer__flag--globe" />,
}

const BADGES = [
  { src: appStoreUrl, alt: 'Download on the App Store', href: '#' },
  { src: googlePlayUrl, alt: 'Get it on Google Play', href: '#' },
  { src: huaweiUrl, alt: 'Explore it on AppGallery', href: '#' },
]

const PAYMENTS = [
  { src: payMadaUrl, alt: 'mada' },
  { src: payVisaUrl, alt: 'Visa' },
  { src: payMastercardUrl, alt: 'Mastercard' },
  { src: payAmexUrl, alt: 'American Express' },
  { src: payApplePayUrl, alt: 'Apple Pay' },
  { src: payStcpayUrl, alt: 'STC Pay' },
  { src: payMokafaaUrl, alt: 'Mokafaa' },
  { src: payQitafUrl, alt: 'Qitaf' },
]

const CONTENT = {
  ltr: {
    appTitle: 'Get the Almosafer app!',
    appDescription:
      'Our app has all your hotel needs covered: Secure payment channels, easy 4-step booking process, and sleek user designs. What more could you ask for?',
    appTagline: 'Join 11M+ users across MENA',
    appCtaLabel: 'Get the app',
    contactHeading: 'Get in touch with us:',
    stats: [
      { value: '11 Million+', label: 'App Downloads' },
      { value: '400K+', label: 'Reviews' },
    ],
    ratings: [
      { score: '4.7', store: 'App Store' },
      { score: '4.8', store: 'Google Play' },
    ],
    contacts: [
      { icon: phoneRaw, title: 'Our team is available 24/7:', value: '8000183803', href: 'tel:8000183803' },
      { icon: whatsappRaw, title: 'Get support via WhatsApp:', value: '+966 55 440 0000', href: 'https://wa.me/966554400000' },
      { icon: storeRaw, title: 'Visit us now:', value: 'Find a branch', href: '#' },
    ],
    columns: [
      { title: 'Corporate', links: [
        { label: 'About us', href: '#' },
        { label: 'Careers', href: '#' },
        { label: 'Almosafer Business', href: '#' },
        { label: 'Almosafer Corporate', href: '#' },
      ] },
      { title: 'Support', links: [
        { label: 'Contact us', href: '#' },
        { label: 'FAQs', href: '#' },
      ] },
      { title: 'Legal', links: [
        { label: 'Terms & conditions', href: '#' },
        { label: 'Privacy Policy', href: '#' },
      ] },
      { title: 'Social media', kind: 'social', links: [
        { label: 'Facebook', href: '#', icon: SOCIAL.facebook },
        { label: 'Instagram', href: '#', icon: SOCIAL.instagram },
        { label: 'Twitter', href: '#', icon: SOCIAL.x },
        { label: 'Youtube', href: '#', icon: SOCIAL.youtube },
        { label: 'LinkedIn', href: '#', icon: SOCIAL.linkedin },
        { label: 'Snapchat', href: '#', icon: SOCIAL.snapchat },
      ] },
      { title: 'Countries', links: [
        { label: 'Saudi Arabia', href: '#', icon: FLAG.sa },
        { label: 'Kuwait', href: '#', icon: FLAG.kw },
        { label: 'United Arab Emirates', href: '#', icon: FLAG.ae },
        { label: 'Egypt', href: '#', icon: FLAG.eg },
        { label: 'Bahrain', href: '#', icon: FLAG.bh },
        { label: 'Oman', href: '#', icon: FLAG.om },
        { label: 'Qatar', href: '#', icon: FLAG.qa },
        { label: 'World Wide', href: '#', icon: FLAG.ww },
      ] },
    ],
    taglines: [
      'Leading Online Travel Agency',
      'Leading Leisure Travel Agency',
      'Leading Corporate Travel Company',
    ],
    licenses: [
      { label: 'Tourism Services License', value: '432873354' },
      { label: 'Commercial Registration', value: '1244274252' },
      { label: 'Category of Business', value: 'General Travel & Tourism Service Provider' },
    ],
    copyright: 'Copyright © 2026 Almosafer',
  },
  rtl: {
    appTitle: 'حمّل تطبيق المسافر!',
    appDescription:
      'يلبّي تطبيقنا كل احتياجات حجوزات فنادقك: قنوات دفع آمنة، وعملية حجز سهلة من ٤ خطوات، وتصميم أنيق وسلس. ماذا تريد أكثر من ذلك؟',
    appTagline: 'انضم إلى أكثر من ١١ مليون مستخدم في الشرق الأوسط',
    appCtaLabel: 'حمّل التطبيق',
    contactHeading: 'تواصل معنا:',
    stats: [
      { value: '+١١ مليون', label: 'عملية تحميل' },
      { value: '+٤٠٠ ألف', label: 'تقييم' },
    ],
    ratings: [
      { score: '٤٫٧', store: 'آب ستور' },
      { score: '٤٫٨', store: 'جوجل بلاي' },
    ],
    contacts: [
      { icon: phoneRaw, title: 'فريقنا متاح على مدار الساعة:', value: '8000183803', href: 'tel:8000183803' },
      { icon: whatsappRaw, title: 'تواصل معنا عبر واتساب:', value: '+966 55 440 0000', href: 'https://wa.me/966554400000' },
      { icon: storeRaw, title: 'زُرنا الآن:', value: 'ابحث عن فرع', href: '#' },
    ],
    columns: [
      { title: 'الشركة', links: [
        { label: 'من نحن', href: '#' },
        { label: 'الوظائف', href: '#' },
        { label: 'المسافر للأعمال', href: '#' },
        { label: 'المسافر للشركات', href: '#' },
      ] },
      { title: 'الدعم', links: [
        { label: 'اتصل بنا', href: '#' },
        { label: 'الأسئلة الشائعة', href: '#' },
      ] },
      { title: 'الأحكام القانونية', links: [
        { label: 'الشروط والأحكام', href: '#' },
        { label: 'سياسة الخصوصية', href: '#' },
      ] },
      { title: 'وسائل التواصل الاجتماعي', kind: 'social', links: [
        { label: 'فيسبوك', href: '#', icon: SOCIAL.facebook },
        { label: 'إنستغرام', href: '#', icon: SOCIAL.instagram },
        { label: 'إكس', href: '#', icon: SOCIAL.x },
        { label: 'يوتيوب', href: '#', icon: SOCIAL.youtube },
        { label: 'لينكد إن', href: '#', icon: SOCIAL.linkedin },
        { label: 'سناب شات', href: '#', icon: SOCIAL.snapchat },
      ] },
      { title: 'الدول', links: [
        { label: 'السعودية', href: '#', icon: FLAG.sa },
        { label: 'الكويت', href: '#', icon: FLAG.kw },
        { label: 'الإمارات العربية المتحدة', href: '#', icon: FLAG.ae },
        { label: 'مصر', href: '#', icon: FLAG.eg },
        { label: 'البحرين', href: '#', icon: FLAG.bh },
        { label: 'عُمان', href: '#', icon: FLAG.om },
        { label: 'قطر', href: '#', icon: FLAG.qa },
        { label: 'حول العالم', href: '#', icon: FLAG.ww },
      ] },
    ],
    taglines: [
      'وكالة السفر الرائدة عبر الإنترنت',
      'وكالة السفر الترفيهي الرائدة',
      'شركة سفر الشركات الرائدة',
    ],
    licenses: [
      { label: 'رخصة خدمات السياحة', value: '432873354' },
      { label: 'السجل التجاري', value: '1244274252' },
      { label: 'نوع النشاط', value: 'مزوّد خدمات السفر والسياحة العامة' },
    ],
    copyright: 'حقوق النشر © 2026 المسافر',
  },
}

const Stars = ({ count = 5 }) => (
  <span className="footer__stars" aria-hidden="true">
    {Array.from({ length: count }).map((_, i) => (
      <RawIcon key={i} svg={starRaw} className="footer__star" />
    ))}
  </span>
)

// ── Desktop layout — the full-width web footer ───────────────────────────────
function FooterDesktop({
  appTitle, appDescription, barcodeSrc, stats, ratings, badges,
  contacts, columns, awardsSrc, taglines, paymentLogos, licenses, copyright,
}) {
  return (
    <>
      {/* ── App-promo band ─────────────────────────────────────────────── */}
      <div className="footer__app-band">
        <div className="footer__app-card">
          <div className="footer__app-inner">
            <div className="footer__promo">
              {(appTitle || appDescription) && (
                <div className="footer__promo-text">
                  {appTitle && <p className="footer__promo-title">{appTitle}</p>}
                  {appDescription && <p className="footer__promo-desc">{appDescription}</p>}
                </div>
              )}

              <div className="footer__download">
                {barcodeSrc && <img className="footer__barcode" src={barcodeSrc} alt="Scan to download the app" />}

                <div className="footer__app-meta">
                  <div className="footer__stats">
                    {stats.map((s, i) => (
                      <div key={s.label} className="footer__stat-group">
                        <div className="footer__stat">
                          <p className="footer__stat-value">{s.value}</p>
                          <p className="footer__stat-label">{s.label}</p>
                        </div>
                        <span className="footer__divider" aria-hidden="true" />
                        {i === stats.length - 1 && ratings.length > 0 && (
                          <div className="footer__ratings">
                            {ratings.map((r) => (
                              <div key={r.store} className="footer__rating">
                                <Stars />
                                <span className="footer__rating-score">{r.score}</span>
                                <span className="footer__rating-store">{r.store}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {badges.length > 0 && (
                    <div className="footer__badges">
                      {badges.map((b) => (
                        <a key={b.alt} className="footer__badge" href={b.href}>
                          <img src={b.src} alt={b.alt} />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {contacts.length > 0 && (
              <div className="footer__contact">
                <span className="footer__contact-divider" aria-hidden="true" />
                <ul className="footer__contact-list">
                  {contacts.map((c) => (
                    <li key={c.title} className="footer__contact-item">
                      <RawIcon svg={c.icon} className="footer__contact-icon" />
                      <a className="footer__contact-link" href={c.href}>
                        <span className="footer__contact-title">{c.title}</span>
                        <span className="footer__contact-value">{c.value}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Links + brand footer ───────────────────────────────────────── */}
      <div className="footer__main">
        <div className="footer__columns">
          {columns.map((col) => (
            <nav key={col.title} className="footer__column" aria-label={col.title}>
              <p className="footer__column-title">{col.title}</p>
              <ul className="footer__links">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a className="footer__link" href={link.href}>
                      {link.icon && <span className="footer__link-icon">{link.icon}</span>}
                      <span>{link.label}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="footer__bottom">
          <Separator />

          <div className="footer__bottom-row">
            {(awardsSrc || taglines.length > 0) && (
              <div className="footer__awards">
                {awardsSrc && <img className="footer__awards-logo" src={awardsSrc} alt="World Travel Awards" />}
                {taglines.length > 0 && (
                  <div className="footer__taglines">
                    {taglines.map((t, i) => (
                      <div key={t} className="footer__tagline-group">
                        <p className="footer__tagline">{t}</p>
                        {i < taglines.length - 1 && <span className="footer__divider footer__divider--sm" aria-hidden="true" />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {paymentLogos.length > 0 && (
              <div className="footer__payments" role="list" aria-label="Accepted payment methods">
                {paymentLogos.map((p) => (
                  <img key={p.alt} className="footer__payment" src={p.src} alt={p.alt} role="listitem" />
                ))}
              </div>
            )}
          </div>

          <Separator />

          <div className="footer__legal-row">
            {licenses.length > 0 && (
              <div className="footer__licenses">
                {licenses.map((l, i) => (
                  <div key={l.label} className="footer__license-group">
                    <div className="footer__license">
                      <p className="footer__license-label">{l.label}</p>
                      <p className="footer__license-value">{l.value}</p>
                    </div>
                    {i < licenses.length - 1 && <span className="footer__divider footer__divider--sm" aria-hidden="true" />}
                  </div>
                ))}
              </div>
            )}
            {copyright && <p className="footer__copyright">{copyright}</p>}
          </div>
        </div>
      </div>
    </>
  )
}

// ── PWA layout — stacked cards for a mobile web-app screen ───────────────────
function FooterPwa({
  appTitle, appTagline, appLogo, appCtaLabel, onAppCta,
  stats, ratings, contacts, contactHeading, columns,
  awardsSrc, taglines, licenses, copyright,
}) {
  const socialCol = columns.find(isSocial)
  const linkCols = columns.filter((c) => !isSocial(c))
  const reviewStat = stats.find((s) => /review/i.test(s.label)) || stats[stats.length - 1]

  return (
    <>
      <div className="footer__pwa-stack">
        {/* app-promo card */}
        <div className="footer__pwa-app">
          <div className="footer__pwa-intro">
            {appLogo}
            {(appTitle || appTagline) && (
              <div className="footer__pwa-app-text">
                {appTitle && <p className="footer__pwa-app-title">{appTitle}</p>}
                {appTagline && <p className="footer__pwa-app-tagline">{appTagline}</p>}
              </div>
            )}
            {appCtaLabel && (
              <Button
                className="footer__pwa-cta"
                variant="primary-inverted"
                size="small"
                label={appCtaLabel}
                onClick={onAppCta}
              />
            )}
          </div>

          {(ratings.length > 0 || reviewStat) && (
            <div className="footer__pwa-metrics">
              {ratings.map((r) => (
                <div key={r.store} className="footer__pwa-metric">
                  <span className="footer__pwa-metric-value">
                    {r.score}
                    <Stars count={1} />
                  </span>
                  <span className="footer__pwa-metric-label">{r.store}</span>
                </div>
              ))}
              {reviewStat && (
                <div className="footer__pwa-metric">
                  <span className="footer__pwa-metric-value">{reviewStat.value}</span>
                  <span className="footer__pwa-metric-label">{reviewStat.label}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* contact card */}
        {contacts.length > 0 && (
          <section className="footer__pwa-card">
            {contactHeading && <p className="footer__pwa-card-title">{contactHeading}</p>}
            <ul className="footer__pwa-contacts">
              {contacts.map((c) => (
                <li key={c.title} className="footer__pwa-contact">
                  <RawIcon svg={c.icon} className="footer__pwa-contact-icon" />
                  <span className="footer__pwa-contact-text">
                    <span className="footer__pwa-contact-title">{c.title}</span>
                    <a className="footer__pwa-contact-value" href={c.href}>{c.value}</a>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* link groups */}
        {linkCols.length > 0 && (
          <section className="footer__pwa-card footer__pwa-links">
            {linkCols.map((col) => (
              <div key={col.title} className="footer__pwa-linkgroup">
                <p className="footer__pwa-linkgroup-title">{col.title}:</p>
                <div className="footer__pwa-linkgroup-list">
                  {col.links.map((link) => (
                    <a key={link.label} className="footer__pwa-link" href={link.href}>{link.label}</a>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* awards + taglines card */}
        {(awardsSrc || taglines.length > 0) && (
          <section className="footer__pwa-card footer__pwa-awards">
            {awardsSrc && <img className="footer__awards-logo" src={awardsSrc} alt="World Travel Awards" />}
            {taglines.length > 0 && (
              <div className="footer__taglines">
                {taglines.map((t, i) => (
                  <div key={t} className="footer__tagline-group">
                    <p className="footer__tagline">{t}</p>
                    {i < taglines.length - 1 && <span className="footer__divider footer__divider--sm" aria-hidden="true" />}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      <div className="footer__pwa-bottom">
        {socialCol && socialCol.links.length > 0 && (
          <nav className="footer__pwa-social" aria-label={socialCol.title}>
            {socialCol.links.map((link) => (
              <a key={link.label} className="footer__pwa-social-link" href={link.href} aria-label={link.label}>
                {link.icon}
              </a>
            ))}
          </nav>
        )}

        {copyright && <p className="footer__copyright footer__pwa-copyright">{copyright}</p>}

        {licenses.length > 0 && (
          <div className="footer__pwa-licenses">
            {licenses.map((l) => (
              <div key={l.label} className="footer__license footer__pwa-license">
                <p className="footer__pwa-license-label">{l.label}</p>
                <p className="footer__license-value">{l.value}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

export function Footer({
  platform = 'desktop',   // desktop (full-width web) | pwa (stacked mobile web-app)
  dir,
  // text props default to the dir-aware Almosafer content (English / Arabic);
  // asset props default to the shared, language-independent sets.
  appTitle,
  appDescription,
  appTagline,
  appLogo,
  appCtaLabel,
  onAppCta,
  barcodeSrc,
  stats,
  ratings,
  badges,
  contacts,
  contactHeading,
  columns,
  awardsSrc,
  taglines,
  paymentLogos,
  licenses,
  copyright,
  className = '',
  ...rest
}) {
  const d = useDir(dir)
  const t = CONTENT[d === 'rtl' ? 'rtl' : 'ltr']
  const cls = ['footer', `footer--${platform}`, className].filter(Boolean).join(' ')

  // explicit prop > dir-aware default
  const content = {
    appTitle: appTitle ?? t.appTitle,
    appDescription: appDescription ?? t.appDescription,
    appTagline: appTagline ?? t.appTagline,
    appLogo: appLogo ?? <AlmosaferLogo type="applogo" width={56} />,
    appCtaLabel: appCtaLabel ?? t.appCtaLabel,
    onAppCta,
    barcodeSrc: barcodeSrc ?? barcodeUrl,
    stats: stats ?? t.stats,
    ratings: ratings ?? t.ratings,
    badges: badges ?? BADGES,
    contacts: contacts ?? t.contacts,
    contactHeading: contactHeading ?? t.contactHeading,
    columns: columns ?? t.columns,
    awardsSrc: awardsSrc ?? awardsUrl,
    taglines: taglines ?? t.taglines,
    paymentLogos: paymentLogos ?? PAYMENTS,
    licenses: licenses ?? t.licenses,
    copyright: copyright ?? t.copyright,
  }

  return (
    <footer className={cls} dir={d} {...rest}>
      {platform === 'pwa' ? <FooterPwa {...content} /> : <FooterDesktop {...content} />}
    </footer>
  )
}
