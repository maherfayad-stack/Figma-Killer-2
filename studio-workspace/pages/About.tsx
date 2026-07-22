import { Button, Chip, Badge } from '@alm-design/design-system'

export default function About() {
  return (
    <div>
      <Chip label="About us" state="default" />
      <Badge count={3} />
      <Button label="Contact" variant="gpay-card" />
    </div>
  )
}
