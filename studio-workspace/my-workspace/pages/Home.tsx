import { Button, Chip } from '@alm-design/design-system'

export default function Home() {
  return (
    <div style={{ display: "flex", flexDirection: "column",
        alignItems: "center",
        gap: "29px",
        width: "40",
        marginTop: "40px"
    }}>
      <Button label="Cancel" variant="apple-pay" state="error" />
      <Button label="New" variant="apple-pay" state="error" />
      <Chip label="New" state="error" />
    </div>
  )
}
