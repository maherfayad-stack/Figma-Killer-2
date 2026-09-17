// Line icon React components sourced from src/icons/line-icons/*.svg
// Use currentColor for stroke/fill so icons inherit color from parent CSS.

export const ChevronRightIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <path d="M9 4.5L16.5 12L9 19.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const ChevronLeftIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <path d="M15 19.5L7.5 12L15 4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const ChevronDownIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <path d="M4.5 9L12 16.5L19.5 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const ChevronUpIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <path d="M4.5 15L12 7.5L19.5 15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const CheckmarkIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <path d="M4 12L9.334 17L20 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const RadioButtonIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <circle cx="12" cy="12" r="9.5" stroke="currentColor" />
  </svg>
)

export const RadioButtonSelectedIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <circle cx="12" cy="12" r="9.5" stroke="currentColor" />
    <circle cx="12" cy="12" r="5" fill="currentColor" />
  </svg>
)

export const CheckboxSquareIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <rect x="2.5" y="2.5" width="19" height="19" rx="4" stroke="currentColor" />
  </svg>
)

export const CheckboxCheckedIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <rect width="24" height="24" rx="4.5" fill="currentColor" />
    <path d="M7 12L10.5 15.5L17 8.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const PlusCircleIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <path d="M12 2.5C17.2467 2.5 21.5 6.75329 21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C6.75329 21.5 2.5 17.2467 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5ZM12 3.5C7.30558 3.5 3.5 7.30558 3.5 12C3.5 16.6944 7.30558 20.5 12 20.5C16.6944 20.5 20.5 16.6944 20.5 12C20.5 7.30558 16.6944 3.5 12 3.5ZM12 7.75C12.2761 7.75 12.5 7.97386 12.5 8.25V11.5H15.75C16.0261 11.5 16.25 11.7239 16.25 12C16.25 12.2761 16.0261 12.5 15.75 12.5H12.5V15.75C12.5 16.0261 12.2761 16.25 12 16.25C11.7239 16.25 11.5 16.0261 11.5 15.75V12.5H8.25C7.97386 12.5 7.75 12.2761 7.75 12C7.75 11.7239 7.97386 11.5 8.25 11.5H11.5V8.25C11.5 7.97386 11.7239 7.75 12 7.75Z" fill="currentColor" />
  </svg>
)

export const MinusCircleIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <path d="M12 2.5C17.2467 2.5 21.5 6.75329 21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C6.75329 21.5 2.5 17.2467 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5ZM12 3.5C7.30558 3.5 3.5 7.30558 3.5 12C3.5 16.6944 7.30558 20.5 12 20.5C16.6944 20.5 20.5 16.6944 20.5 12C20.5 7.30558 16.6944 3.5 12 3.5ZM15.75 11.5C16.0261 11.5 16.25 11.7239 16.25 12C16.25 12.2761 16.0261 12.5 15.75 12.5H8.25C7.97386 12.5 7.75 12.2761 7.75 12C7.75 11.7239 7.97386 11.5 8.25 11.5H15.75Z" fill="currentColor" />
  </svg>
)

export const PlaceholderIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
    <path d="M19.5 3.25C20.1904 3.25 20.75 3.80964 20.75 4.5V19.5C20.75 20.1904 20.1904 20.75 19.5 20.75H4.5C3.80964 20.75 3.25 20.1904 3.25 19.5V4.5C3.25 3.80964 3.80964 3.25 4.5 3.25H19.5ZM4.25 19.5C4.25 19.6381 4.36193 19.75 4.5 19.75H19.043L4.25 4.95703V19.5ZM19.75 19.043V4.5C19.75 4.36193 19.6381 4.25 19.5 4.25H4.95703L19.75 19.043Z" fill="currentColor" />
  </svg>
)
