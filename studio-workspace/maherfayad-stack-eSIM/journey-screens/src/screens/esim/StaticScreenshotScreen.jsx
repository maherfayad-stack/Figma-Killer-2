import './StaticScreenshotScreen.css'

export default function StaticScreenshotScreen({ src, alt, onClick }) {
  return (
    <div className="static-screenshot" onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <img src={src} alt={alt} className="static-screenshot__image" />
    </div>
  )
}
