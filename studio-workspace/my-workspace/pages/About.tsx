import { Button, Chip, Badge } from '@alm-design/design-system'

export default function About() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
        marginTop: "20px",
        paddingTop: "200px"
    }}>
      <Chip label="About us" state="default" />
      <Badge count={3} />
      <Button label="Contact" variant="gpay-card" />
    </div>
  )
}
