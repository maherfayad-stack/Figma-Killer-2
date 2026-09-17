import { forwardRef, useId, useRef, useState } from 'react'
import { usePlatform, useDir } from '../context/DesignSystemContext'
import magnifyingGlassRaw from '../icons/line-icons/maginfyingGlass.svg?raw'
import micRaw from '../icons/line-icons/mic.svg?raw'
import xRaw from '../icons/line-icons/x.svg?raw'
import xCircleFillRaw from '../icons/line-icons/xCircleFill.svg?raw'
import arrowLeftRaw from '../icons/line-icons/arrowLeft.svg?raw'
import arrowRightRaw from '../icons/line-icons/arrowRight.svg?raw'
import './Search.css'

// design-system line icons — these svgs use currentColor, so CSS tints them via the icon-* tokens
const RawIcon = ({ svg }) => (
  <span
    aria-hidden="true"
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}
    dangerouslySetInnerHTML={{ __html: svg }}
  />
)

const SearchIcon = () => <RawIcon svg={magnifyingGlassRaw} />
const MicIcon = () => <RawIcon svg={micRaw} />
const ClearIcon = () => <RawIcon svg={xCircleFillRaw} />   // iOS in-pill clear — filled circle ×
const XIcon = () => <RawIcon svg={xRaw} />                  // bare × — Android clear, iOS close
// Android leading back arrow — physically mirrored for RTL (points the way out).
const BackArrowIcon = ({ dir }) => <RawIcon svg={dir === 'rtl' ? arrowRightRaw : arrowLeftRaw} />
const CloseIcon = XIcon

export const Search = forwardRef(function Search({
  value,
  onChange,
  label,
  onFocus: onFocusProp,
  onBlur: onBlurProp,
  onClear,
  onClose,
  placeholder,
  showClose = false,
  platform,
  dir,
  id: idProp,
  className,
  ...props
}, ref) {
  const p = usePlatform(platform)
  const d = useDir(dir)

  const uid = useId()
  const id = idProp ?? uid

  const internalRef = useRef(null)
  const resolvedRef = ref ?? internalRef

  const [focused, setFocused] = useState(false)

  // Controlled when `value` is supplied; otherwise uncontrolled, seeded once from `label`.
  const isControlled = value !== undefined
  const [internalValue, setInternalValue] = useState(label ?? '')
  const currentValue = isControlled ? value : internalValue

  const hasValue = currentValue != null && String(currentValue).length > 0
  const defaultPlaceholder = d === 'rtl' ? 'بحث' : 'Search'

  function handleFocus(e) {
    setFocused(true)
    onFocusProp?.(e)
  }

  function handleBlur(e) {
    setFocused(false)
    onBlurProp?.(e)
  }

  function handleChange(e) {
    if (!isControlled) setInternalValue(e.target.value)
    onChange?.(e)
  }

  function handleClear() {
    if (!isControlled) setInternalValue('')
    onClear?.()
    resolvedRef.current?.focus()
  }

  const input = (
    <input
      ref={resolvedRef}
      id={id}
      className="search__input"
      type="search"
      value={currentValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      placeholder={placeholder ?? defaultPlaceholder}
      {...props}
    />
  )

  // ── Android — Material docked search bar ──
  // Resting: leading magnifier + hint + trailing mic.
  // Active (focused or has text): leading back arrow (collapses) + trailing clear ×.
  if (p === 'android') {
    const active = focused || hasValue
    const cls = ['search', 'search--android', className].filter(Boolean).join(' ')

    return (
      <div className={cls} dir={d}>
        <div className="search__pill" onClick={() => resolvedRef.current?.focus()}>
          {active ? (
            <button
              type="button"
              className="search__icon-btn search__icon-btn--leading"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); onClose?.() }}
              aria-label={d === 'rtl' ? 'إغلاق البحث' : 'Close search'}
            >
              <span className="search__icon-btn-glyph">
                <BackArrowIcon dir={d} />
              </span>
            </button>
          ) : (
            <span className="search__icon-btn search__icon-btn--leading" aria-hidden="true">
              <span className="search__icon-btn-glyph">
                <SearchIcon />
              </span>
            </span>
          )}

          {input}

          {active ? (
            <button
              type="button"
              className="search__icon-btn search__icon-btn--trailing"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); handleClear() }}
              aria-label={d === 'rtl' ? 'مسح البحث' : 'Clear search'}
            >
              <span className="search__icon-btn-glyph">
                <XIcon />
              </span>
            </button>
          ) : (
            <span className="search__icon-btn search__icon-btn--trailing" aria-hidden="true">
              <span className="search__icon-btn-glyph">
                <MicIcon />
              </span>
            </span>
          )}
        </div>
      </div>
    )
  }

  // ── iOS — liquid-glass pill ──
  const cls = [
    'search',
    'search--ios',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={cls} dir={d}>
      <div
        className="search__pill"
        onClick={() => resolvedRef.current?.focus()}
      >
        <span className="search__icon">
          <SearchIcon />
        </span>
        {input}
        {!hasValue && (
          <span className="search__icon search__icon--trailing">
            <MicIcon />
          </span>
        )}
        {hasValue && (
          <button
            type="button"
            className="search__clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleClear}
            aria-label={d === 'rtl' ? 'مسح البحث' : 'Clear search'}
          >
            <ClearIcon />
          </button>
        )}
      </div>
      {showClose && (
        <button
          type="button"
          className="search__close"
          onClick={onClose}
          aria-label={d === 'rtl' ? 'إغلاق البحث' : 'Close search'}
        >
          <span className="search__close-icon">
            <CloseIcon />
          </span>
        </button>
      )}
    </div>
  )
})
