import './ProgressStepper.css'

export function ProgressStepper({ steps = 5, currentStep = 1, className, ...props }) {
  const cls = ['progress-stepper', className].filter(Boolean).join(' ')
  return (
    <div className={cls} {...props}>
      {Array.from({ length: steps }, (_, i) => (
        <div
          key={i}
          className={['progress-stepper__step', i < currentStep && 'progress-stepper__step--completed'].filter(Boolean).join(' ')}
        />
      ))}
    </div>
  )
}
