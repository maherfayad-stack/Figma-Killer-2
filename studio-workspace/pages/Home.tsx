import { Button, Chip } from '@alm-design/design-system'

export default function Home() {
  return (
    <div>
      <Button label="Log in" variant="destructive" />
      <Button label="Cancel" variant="apple-pay" />
      <Chip label="New" state="error" />
    </div>
  )
}
