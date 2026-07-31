/* Renders illustration SVGs (hardcoded hex fills) as inline SVG with
 * design-token substitution, so they flip correctly in dark mode. */

const SUBSTITUTIONS = [
  ['fill="#E9F6F8"', 'fill="var(--color-aqua-10)"'],
  ['fill="#E8F5F7"', 'fill="var(--color-aqua-10)"'],
  ['fill="#BDE4EA"', 'fill="var(--color-aqua-30)"'],
  ['fill="#BDE2E8"', 'fill="var(--color-aqua-30)"'],
  ['fill="#91D2DC"', 'fill="var(--color-aqua-50)"'],
  ['fill="#0C9AB0"', 'fill="var(--color-aqua-100)"'],
  ['stroke="#0C9AB0"', 'stroke="var(--color-aqua-100)"'],
  ['stroke="#0C8395"', 'stroke="var(--color-aqua-200)"'],
  ['fill="#EF4550"', 'fill="var(--color-coral-100)"'],
  ['fill="white"', 'fill="var(--background-base-default)"'],
  ['fill="#FFFFFF"', 'fill="var(--background-base-default)"'],
  ['fill="#ffffff"', 'fill="var(--background-base-default)"'],
]

function applyTokens(raw) {
  let out = raw
  for (const [from, to] of SUBSTITUTIONS) {
    out = out.replaceAll(from, to)
  }
  return out
}

export default function IllustrationIcon({ svg, size = 48, className }) {
  return (
    <span
      className={['ds-raw-icon', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: applyTokens(svg) }}
    />
  )
}
