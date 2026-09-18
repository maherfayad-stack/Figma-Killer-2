import { forwardRef, useId, useLayoutEffect, useRef, useState } from 'react'
import xCircleFill from '../icons/line-icons/xCircleFill.svg?raw'
import chevronDownRaw from '../icons/line-icons/chevronDown.svg?raw'
import chevronUpRaw from '../icons/line-icons/chevronUp.svg?raw'
import eyeRaw from '../icons/line-icons/eye.svg?raw'
import eyeSlashRaw from '../icons/line-icons/eyeSlash.svg?raw'
import './TextInput.css'

// these svgs use currentColor, so CSS tints them via the icon-* tokens
const ChevronIcon = ({ up }) => (
  <span
    aria-hidden="true"
    style={{ display: 'flex', width: '100%', height: '100%' }}
    dangerouslySetInnerHTML={{ __html: up ? chevronUpRaw : chevronDownRaw }}
  />
)

// off = password hidden → eye-slash; otherwise (revealed) → eye
const EyeIcon = ({ off }) => (
  <span
    aria-hidden="true"
    style={{ display: 'flex', width: '100%', height: '100%' }}
    dangerouslySetInnerHTML={{ __html: off ? eyeSlashRaw : eyeRaw }}
  />
)

const WarningCircleIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ width: '100%', height: '100%' }}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 3.5C7.30558 3.5 3.5 7.30558 3.5 12C3.5 16.6944 7.30558 20.5 12 20.5C16.6944 20.5 20.5 16.6944 20.5 12C20.5 7.30558 16.6944 3.5 12 3.5ZM2.5 12C2.5 6.75329 6.75329 2.5 12 2.5C17.2467 2.5 21.5 6.75329 21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C6.75329 21.5 2.5 17.2467 2.5 12ZM12 7C12.2761 7 12.5 7.22386 12.5 7.5V12.75C12.5 13.0261 12.2761 13.25 12 13.25C11.7239 13.25 11.5 13.0261 11.5 12.75V7.5C11.5 7.22386 11.7239 7 12 7ZM12.75 16.125C12.75 16.5392 12.4142 16.875 12 16.875C11.5858 16.875 11.25 16.5392 11.25 16.125C11.25 15.7108 11.5858 15.375 12 15.375C12.4142 15.375 12.75 15.7108 12.75 16.125Z"
      fill="currentColor"
    />
  </svg>
)

const XCircleIcon = () => (
  <span
    aria-hidden="true"
    style={{ display: 'flex', width: '100%', height: '100%' }}
    dangerouslySetInnerHTML={{ __html: xCircleFill }}
  />
)

export const TextInput = forwardRef(function TextInput({
  disabled = false,
  skeleton = false,
  required = false,
  label,
  value,
  onChange,
  onFocus: onFocusProp,
  onBlur: onBlurProp,
  onClear,
  helperText,
  errorText,
  leadingIcon,
  trailingIcon,
  dropdown = false,
  multiline = false,
  password = false,
  children,
  id: idProp,
  dir = 'ltr',
  className,
  ...props
}, ref) {
  const uid = useId()
  const id = idProp ?? uid

  // keep an internal ref (for focus + textarea autosize) while still forwarding
  const internalRef = useRef(null)
  const setRefs = (node) => {
    internalRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

  const [focused, setFocused] = useState(false)
  // password hidden by default; the reveal toggle flips this
  const [revealed, setRevealed] = useState(false)

  // grow the textarea to fit its content
  useLayoutEffect(() => {
    if (!multiline) return
    const el = internalRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [multiline, value])

  const isDisabled = Boolean(disabled)
  const isError = Boolean(errorText)
  const isFloating = focused || (value != null && String(value) !== '') || isDisabled

  function handleFocus(e) {
    setFocused(true)
    onFocusProp?.(e)
  }

  function handleBlur(e) {
    setFocused(false)
    onBlurProp?.(e)
  }

  if (skeleton) {
    return (
      <div className={['text-input text-input--skeleton', className].filter(Boolean).join(' ')} dir={dir}>
        <div className="text-input__skeleton-field" />
        <div className="text-input__skeleton-helper" />
      </div>
    )
  }

  const showClear = Boolean(onClear) && !isError && value != null && String(value) !== ''

  const cls = [
    'text-input',
    isError && 'text-input--error',
    focused && 'text-input--focus',
    isDisabled && 'text-input--disabled',
    multiline && 'text-input--multiline',
    className,
  ].filter(Boolean).join(' ')

  // count leading elements so the floating label can offset back to the field
  // edge regardless of how many shift the content area right
  const leadingCount = leadingIcon ? 1 : 0

  return (
    <div
      className={cls}
      dir={dir}
      style={leadingCount ? { '--text-input-lead-count': leadingCount } : undefined}
    >
      <div className="text-input__control">
      <div className="text-input__field" onClick={() => internalRef.current?.focus()}>
        {leadingIcon && <span className="text-input__icon">{leadingIcon}</span>}
        <div className={['text-input__content', isFloating && 'text-input__content--floating'].filter(Boolean).join(' ')}>
          {label && (
            <label className="text-input__label" htmlFor={id}>
              {label}{required && <span className="text-input__required" aria-hidden="true"> *</span>}
            </label>
          )}
          {multiline ? (
            <textarea
              ref={setRefs}
              id={id}
              className="text-input__input"
              disabled={isDisabled}
              required={required}
              value={value}
              rows={1}
              onChange={onChange}
              onInput={(e) => {
                // cover uncontrolled usage where value-effect won't re-run
                e.currentTarget.style.height = 'auto'
                e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`
              }}
              onFocus={handleFocus}
              onBlur={handleBlur}
              aria-invalid={isError ? true : undefined}
              {...props}
            />
          ) : (
            <input
              ref={setRefs}
              id={id}
              className="text-input__input"
              disabled={isDisabled}
              required={required}
              value={value}
              onChange={onChange}
              onFocus={handleFocus}
              onBlur={handleBlur}
              aria-invalid={isError ? true : undefined}
              {...props}
              type={password ? (revealed ? 'text' : 'password') : props.type}
            />
          )}
        </div>
        {isError && (
          <span className="text-input__icon text-input__icon--error">
            <WarningCircleIcon />
          </span>
        )}
        {!isError && password && (
          <button
            type="button"
            className="text-input__reveal"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => { e.stopPropagation(); setRevealed((v) => !v) }}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            aria-pressed={revealed}
          >
            <EyeIcon off={!revealed} />
          </button>
        )}
        {!isError && !password && showClear && (
          <button
            type="button"
            className="text-input__clear"
            onClick={(e) => { e.stopPropagation(); onClear(e) }}
            tabIndex={-1}
            aria-label="Clear"
          >
            <XCircleIcon />
          </button>
        )}
        {!isError && !password && !showClear && trailingIcon && (
          <span className="text-input__icon">{trailingIcon}</span>
        )}
        {dropdown && (
          <span className="text-input__chevron">
            <ChevronIcon up={focused} />
          </span>
        )}
      </div>
      {dropdown && focused && (
        // onMouseDown preventDefault keeps the input focused (panel open) while
        // interacting with the slot content
        <div className="text-input__panel" onMouseDown={(e) => e.preventDefault()}>
          {children}
        </div>
      )}
      </div>
      {!isError && helperText && (
        <p className="text-input__helper">{helperText}</p>
      )}
      {isError && errorText && (
        <p className="text-input__helper text-input__helper--error">{errorText}</p>
      )}
    </div>
  )
})
