export default function Icon({ svg, size = 24, className, style }) {
  return (
    <span
      className={['ds-raw-icon', className].filter(Boolean).join(' ')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: size,
        height: size,
        ...style,
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
