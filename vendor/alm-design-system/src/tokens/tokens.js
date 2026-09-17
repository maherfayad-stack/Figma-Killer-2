/* ALM 2.0 — JS token exports for use in inline styles, animations, or tests */

export const colorsDark = {
  // Neutral
  metal:     '#F8F9F9',
  chateau:   '#929FA3',
  montreal:  '#515B5E',
  gainsboro: '#3C4244',
  alice:     '#2C2F30',
  ghost:     '#232525',
  light:     '#1C1C1C',
  // static values unchanged in dark mode
  whiteStatic: '#FFFFFF',
  blackStatic: '#1C1C1C',
  // Aqua
  aqua10:  '#1F2A2C',
  aqua30:  '#24464B',
  aqua50:  '#2A626B',
  aqua100: '#07ACC5',
  aqua200: '#0394AA',
  // Coral
  coral10:  '#59393E',
  coral100: '#E9666F',
  coral200: '#EA3944',
  // Forest
  forest10:  '#1B2C1C',
  forest100: '#599B5D',
  forest200: '#26972C',
  // Butter
  butter10:  '#30291D',
  butter100: '#E79924',
  // Purple
  lavender: '#34303F',
  iris:     '#6127AA',
  amethyst: '#875BF7',   // static — PurpleBlue gradient start
  // Brand
  apple: '#F8F9F9',
  // Black / Light alpha — black stays black, light flips to #1C1C1C
  black50: 'rgba(0, 0, 0, 0.5)',
  light40: 'rgba(28, 28, 28, 0.4)',
  light92: 'rgba(28, 28, 28, 0.92)',
  // Gradient colors — static (identical in dark mode)
  sulu:      '#CEFF99',
  mint:      '#99FFDF',
  dodger:    '#2E90FA',
  bondi:     '#00879C',
  glacier:   '#01BAD7',
  malachite: '#0CB038',
  grey10:    'rgba(105, 117, 134, 0.10)',
  grey30:    'rgba(105, 117, 134, 0.30)',
  blue10:    'rgba(46, 144, 250, 0.10)',
  blue30:    'rgba(46, 144, 250, 0.30)',
  green10:   'rgba(102, 198, 28, 0.10)',
  green30:   'rgba(102, 198, 28, 0.30)',
  purple10:  'rgba(135, 91, 247, 0.10)',
  purple30:  'rgba(135, 91, 247, 0.30)',
  black70:   'rgba(0, 0, 0, 0.70)',
  black40:   'rgba(0, 0, 0, 0.40)',
}

export const colors = {
  // Neutral
  metal:        '#1C1C1C',
  chateau:      '#66797F',
  montreal:     '#A1AAAD',
  gainsboro:    '#D8DCDE',
  alice:        '#EDF1F3',
  ghost:        '#F7F9FA',
  light:        '#FFFFFF',
  whiteStatic:  '#FFFFFF',
  metalStatic:  '#1C1C1C',
  // Aqua
  aqua10:  '#E9F6F8',
  aqua30:  '#BDE4EA',
  aqua50:  '#91D2DC',
  aqua100: '#0C9AB0',
  aqua200: '#008296',
  // Coral
  coral10:  '#F4E3E4',
  coral100: '#EF4550',
  coral200: '#D23241',
  // Forest
  forest10:  '#EAF5EB',
  forest100: '#319E37',
  forest200: '#0A8A11',
  // Butter
  butter10:  '#FEF5E6',
  butter100: '#FE9C09',
  // Purple
  lavender: '#F7F1FF',
  iris:     '#E8D4FF',
  amethyst: '#875BF7',   // static — PurpleBlue gradient start
  // Brand
  almosafer:       '#003143',
  whatsapp:        '#25D366',
  facebook:        '#0866FF',
  shukran:         '#F0DBB1',
  shukranContrast: '#4A2A1F',
  qitaf:           '#4F008C',
  mokafaa:         '#221AFB',
  emkan:           '#0CBAB4',
  alfursan:        '#006937',
  apple:           '#000000',
  // Black / Light alpha
  black50: 'rgba(0, 0, 0, 0.5)',
  light40: 'rgba(255, 255, 255, 0.4)',
  light92: 'rgba(255, 255, 255, 0.92)',
  // Gradient colors — static (identical in dark mode)
  sulu:      '#CEFF99',
  mint:      '#99FFDF',
  dodger:    '#2E90FA',
  bondi:     '#00879C',
  glacier:   '#01BAD7',
  malachite: '#0CB038',
  grey10:    'rgba(105, 117, 134, 0.10)',
  grey30:    'rgba(105, 117, 134, 0.30)',
  blue10:    'rgba(46, 144, 250, 0.10)',
  blue30:    'rgba(46, 144, 250, 0.30)',
  green10:   'rgba(102, 198, 28, 0.10)',
  green30:   'rgba(102, 198, 28, 0.30)',
  purple10:  'rgba(135, 91, 247, 0.10)',
  purple30:  'rgba(135, 91, 247, 0.30)',
  black70:   'rgba(0, 0, 0, 0.70)',
  black40:   'rgba(0, 0, 0, 0.40)',
}

export const spacing = {
  unit: 8,
  '2xs': 2,
  xs:    4,
  sm:    8,
  md:    12,
  base:  16,
  lg:    24,
  xl:    32,
  '2xl': 40,
  '3xl': 48,
  '4xl': 64,
  container: 16,
  cardGap:   12,
  section:   32,
}

export const rounded = {
  xs:      '4px',
  sm:      '8px',
  base:    '12px',
  lg:      '16px',
  popover: '34px',
  full:    '100px',
}

export const elevation = {
  floating: '0px -4px 16px rgba(0, 0, 0, 0.08)',
  raised:   '0px 8px 24px rgba(0, 0, 0, 0.12)',
}

export const typography = {
  display: {
    fontFamily:    "'Open Sans', system-ui, sans-serif",
    fontSize:      '34px',
    fontWeight:    600,
    lineHeight:    '52px',
    letterSpacing: '-1px',
  },
  headline: {
    fontFamily:    "'Open Sans', system-ui, sans-serif",
    fontSize:      '26px',
    fontWeight:    600,
    lineHeight:    '40px',
    letterSpacing: '-0.6px',
  },
  title: {
    fontFamily:    "'Open Sans', system-ui, sans-serif",
    fontSize:      '18px',
    fontWeight:    600,
    lineHeight:    '28px',
    letterSpacing: '-0.2px',
  },
  titleBold: {
    fontFamily:    "'Open Sans', system-ui, sans-serif",
    fontSize:      '18px',
    fontWeight:    700,
    lineHeight:    '28px',
    letterSpacing: '-0.2px',
  },
  subtitle: {
    fontFamily: "'Open Sans', system-ui, sans-serif",
    fontSize:   '16px',
    fontWeight: 600,
    lineHeight: '24px',
  },
  subtitleBold: {
    fontFamily: "'Open Sans', system-ui, sans-serif",
    fontSize:   '16px',
    fontWeight: 700,
    lineHeight: '24px',
  },
  eyebrow: {
    fontFamily:    "'Open Sans', system-ui, sans-serif",
    fontSize:      '12px',
    fontWeight:    400,
    lineHeight:    '16px',
    letterSpacing: '1.5px',
  },
  bodyRegular: {
    fontFamily: "'Open Sans', system-ui, sans-serif",
    fontSize:   '14px',
    fontWeight: 400,
    lineHeight: '20px',
  },
  bodySemibold: {
    fontFamily: "'Open Sans', system-ui, sans-serif",
    fontSize:   '14px',
    fontWeight: 600,
    lineHeight: '20px',
  },
  bodyBold: {
    fontFamily: "'Open Sans', system-ui, sans-serif",
    fontSize:   '14px',
    fontWeight: 700,
    lineHeight: '20px',
  },
  captionRegular: {
    fontFamily: "'Open Sans', system-ui, sans-serif",
    fontSize:   '12px',
    fontWeight: 400,
    lineHeight: '16px',
  },
  captionSemibold: {
    fontFamily: "'Open Sans', system-ui, sans-serif",
    fontSize:   '12px',
    fontWeight: 600,
    lineHeight: '16px',
  },
  metaRegular: {
    fontFamily: "'Open Sans', system-ui, sans-serif",
    fontSize:   '11px',
    fontWeight: 400,
    lineHeight: '14px',
  },
  metaSemibold: {
    fontFamily: "'Open Sans', system-ui, sans-serif",
    fontSize:   '11px',
    fontWeight: 600,
    lineHeight: '14px',
  },
}
