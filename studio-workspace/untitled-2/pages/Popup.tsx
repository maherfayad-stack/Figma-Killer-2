import { Dialog } from '@alm-design/design-system'

export default function Popup() {
  return (
    <Dialog
      platform="ios"
      title="Popup"
      description="One question, asked once. Replace this with the decision this popup exists to ask for."
      primaryAction={{ label: 'Confirm' }}
      secondaryAction={{ label: 'Not now' }}
    />
  )
}
